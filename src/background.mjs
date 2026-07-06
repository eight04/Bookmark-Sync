import browser from "webextension-polyfill";
import {diff, applyPatch} from "flat-json-diff";

import {builtinIds, NATIVE_ID, USER_AGENT} from "./lib/env.js";
import * as logger from "./lib/logger.js";

let running = false;
let bookmarkChanged = true; // assume changed on startup
let syncError = null;

init();

async function initChromeBuiltinIds() {
  const [root] = await browser.bookmarks.getTree();
  for (const cat of root.children) {
    // FIXME: chromium browsers don't have a persistent builtin ID for root folders. We have to rely on checking titles...
    // does title changes when UI language changes?
    // folderType works with Chrome 134+
    if (cat.folderType === "bookmarks-bar" || /fav.*bar/i.test(cat.title)) {
      builtinIds.toolbar.chrome = cat.id;
    } else if (cat.folderType === "other" || /other.*fav/i.test(cat.title)) {
      builtinIds.other.chrome = cat.id;
    } else if (cat.folderType === "mobile") {
      builtinIds.mobile.chrome = cat.id;
    } else {
      logger.log("The following folder is not synced", cat.id, cat.title, cat.folderType);
    }
  }
}

async function init() {
  if (USER_AGENT === "chrome") {
    await initChromeBuiltinIds();
  }

  browser.bookmarks.onCreated.addListener(onBookmarkChanged)
  browser.bookmarks.onRemoved.addListener(onBookmarkChanged)
  browser.bookmarks.onChanged.addListener(onBookmarkChanged)
  browser.bookmarks.onMoved.addListener(onBookmarkChanged)
  browser.storage.onChanged.addListener(changes => {
    if (changes.token || changes.gistId) {
      // FIXME: should we clear bookmarkData when token is changed?
      scheduleSync();
    }
  });

  scheduleSync();

  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'sync') {
      sync().catch(e => console.error(e));
    }
  });

  const HANDLE_MESSAGE = {
    getSyncError: () => Promise.resolve(syncError && String(syncError)),
    sync: () => sync(),
    getLogs: () => Promise.resolve(logger.records),
  }

  browser.runtime.onMessage.addListener(message => {
    if (HANDLE_MESSAGE[message.action]) {
      return HANDLE_MESSAGE[message.action](message);
    }
  });

  browser.browserAction.onClicked.addListener(() => {
    browser.runtime.openOptionsPage();
  });
}

async function sync() {
  if (running) {
    scheduleSync();
    throw new Error("sync is already running");
  }
  running = true;
  try {
    await _sync();
    syncError = null;
  } catch (e) {
    console.error(e);
    logger.log("Sync error:", e.message || String(e));
    syncError = e;
    await delay(5000);
    throw e;
  } finally {
    running = false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let remoteLastModified = null;
async function getRemoteData(token, gistId, isFirstSync) {
  const r = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'GET',
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${token}`
    },
  });
  if (!r.ok) {
    throw new Error(await r.text());
  }
  const newLastModified = r.headers.get('last-modified');
  if (!isFirstSync && remoteLastModified === newLastModified) {
    logger.log("remote gist not modified");
    return null;
  }
  remoteLastModified = newLastModified;
  const data = await r.json();
  if (data.truncated) {
    throw new Error("Gist content is too large");
  }
  if (!data.files['bookmark.json']) {
    logger.log("remote gist has no bookmark.json");
    return null;
  }
  if (data.files['bookmark.json'].truncated) {
    throw new Error("bookmark.json is too large");
  }
  return JSON.parse(data.files['bookmark.json'].content);
}

async function _sync() {
  // FIXME: there is no locking mechanism to gist, concurrent sync may cause data loss
  logger.log(`sync start, bookmarkChanged: ${bookmarkChanged}`);
  let {token, bookmarkData: storedData, gistId, syncMode = "merge"} = await browser.storage.local.get(['token', 'bookmarkData', 'gistId', 'syncMode']);
  const isFirstSync = !storedData;
  if (!token || !gistId) {
    logger.log("not login");
    return;
  }
  const remoteData = await getRemoteData(token, gistId, isFirstSync);
  const shouldPull = remoteData && (!storedData || remoteData.lastUpdate > storedData.lastUpdate);
  const shouldPush = isFirstSync ? syncMode !== "pullOnly" : bookmarkChanged;
  bookmarkChanged = false;
  logger.log(`shouldPull: ${shouldPull}, shouldPush: ${shouldPush}`);

  const currentData = shouldPush ? await getBookmarkData() : null;
  const finalDataArr = [];

  if (shouldPull) {
    await patchBookmark(remoteData);
    finalDataArr.push(storedData, remoteData);
  }
  if (shouldPush) {
    let diff;
    if (isFirstSync && syncMode === "merge" && remoteData) {
      // merge mode on first sync: merge remoteData and currentData
      diff = diffBookmarkData(remoteData, currentData, {noDelete: true, isAtomic: (obj) => {
        return obj.type === "bookmark" || obj.type === "separator";
      }});
    } else {
      diff = diffBookmarkData(storedData || {}, currentData);
    }
    if (diff) {
      if (shouldPull) {
        // apply diff to remoteData
        try {
          await patchBookmarkDiff(diff, remoteData);
          finalDataArr.push(remoteData, await getBookmarkData());
        } catch (e) {
          logger.log("failed to apply diff to remoteData", e.message || String(e));
          browser.storage.local.set({[`wip-${Date.now()}`]: diff});
        }
      } else {
        // push full data
        finalDataArr.push(storedData, currentData);
      }
    }
  }
  if (!finalDataArr.length) {
    logger.log("no changes");
    return;
  }
  const finalData = mergeDataArr(finalDataArr);
  if (!remoteData || finalData.lastUpdate > remoteData.lastUpdate) {
    await patchGist(finalData, token, gistId);
  }
  if (!storedData || finalData.lastUpdate > storedData.lastUpdate) {
    await browser.storage.local.set({bookmarkData: finalData});
  }
  logger.log("sync finished");
}

function diffBookmarkData(oldData, newData, options) {
  const result = {};
  for (const key in builtinIds) {
    if (!newData[key]) continue;
    const r = diff(oldData[key] || [], newData[key], options);
    if (!r) continue;
    result[key] = r;
  }
  if (Object.keys(result).length === 0) {
    return null;
  }
  return result;
}

async function patchBookmarkDiff(diff, data) {
  data = structuredClone(data);
  for (const key in diff) {
    if (!data[key]) {
      data[key] = [];
    }
    data[key] = applyPatch(data[key], diff[key]);
  }
  await patchBookmark(data);
}

function mergeDataArr(dataArr) {
  const o = {};
  const set = new Set;
  for (const data of dataArr) {
    if (!data) continue;
    if (set.has(data)) continue;
    set.add(data);
    Object.assign(o, data);
  }
  return o;
}

async function getBookmarkData() {
  const data = {
    userAgent: navigator.userAgent,
    lastUpdate: Date.now(),
  };
  for (const key in builtinIds) {
    const parentId = builtinIds[key][USER_AGENT];
    if (!parentId) continue;
    const bookmarks = await browser.bookmarks.getSubTree(parentId);
    data[key] = bookmarks[0].children.map(cleanBookmark);
  }
  return data;
}

function cleanBookmark(bookmark) {
  const b = {
    [NATIVE_ID]: bookmark.id,
    type: getBookmarkType(bookmark),
  };
  if (b.type !== "separator") {
    b.title = bookmark.title;
  }
  if (b.type === "bookmark") {
    b.url = bookmark.url;
  }
  if (b.type === "folder") {
    b.children = (bookmark.children || []).map(cleanBookmark);
  }
  return b;
}

async function patchGist(data, token, gistId) {
  logger.log("patch remote gist");
  const r = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${token}`
    },
    body: JSON.stringify({
      files: {
        'bookmark.json': {
          content: JSON.stringify(data, null, 2)
        }
      }
    })
  });
  if (!r.ok) {
    throw new Error(await r.text());
  }
}

async function patchBookmark(remote) {
  logger.log("patch local bookmarks");
  for (const baseKey in builtinIds) {
    const parentId = builtinIds[baseKey][USER_AGENT];
    if (!parentId) continue;
    const localBookmarks = await browser.bookmarks.getSubTree(parentId);
    await patchBookmarkFolder(localBookmarks[0].children, remote[baseKey], parentId);
  }
}

function isSameBookmark(a, b) {
  if (!a || !b) return false;
  if (getBookmarkType(a) !== getBookmarkType(b)) return false;
  if (a.title !== b.title) return false;
  if (a.url !== b.url) return false;
  return true;
}

function getBookmarkType(bookmark) {
  if (bookmark.type) return bookmark.type;
  if (bookmark.children || bookmark.url == null) return 'folder';
  if (bookmark.title.match(/^-+$/)) return 'separator';
  return 'bookmark';
}

// NOTE: bookmark.children is often undefined in Chrome when the folder is empty
async function patchBookmarkFolder(local = [], remote, parentId) {
  let i = 0, j = 0;
  for (; i < local.length && j < remote.length;) {
    if (isSameBookmark(local[i], remote[j])) {
      if (remote[j].children) {
        await patchBookmarkFolder(local[i].children, remote[j].children, local[i].id);
      }
      i++;
      j++;
      continue;
    }
    // FIXME: should we use a more advanced algorithm to find reordered items?
    if (isSameBookmark(local[i], remote[j + 1])) {
      // remote[j] is new
      const r = await createBookmark({
        index: j,
        parentId,
        title: remote[j].title,
        url: remote[j].url,
        type: getBookmarkType(remote[j])
      });
      if (remote[j].children) {
        await patchBookmarkFolder(r.children, remote[j].children, r.id);
      }
      j++;
      continue;
    }
    // local[i] is deleted
    // remoteTree can also remove a single bookmark
    await browser.bookmarks.removeTree(local[i].id);
    i++;
    continue;
  }
  for (;i < local.length; i++) {
    await browser.bookmarks.removeTree(local[i].id);
  }
  for (;j < remote.length; j++) {
    const r = await createBookmark({
      index: j,
      parentId,
      title: remote[j].title,
      url: remote[j].url,
      type: getBookmarkType(remote[j])
    });
    if (remote[j].children) {
      await patchBookmarkFolder(r.children, remote[j].children, r.id);
    }
  }
}
    
async function onBookmarkChanged() {
  const {token, gistId} = await browser.storage.local.get(['token', 'gistId']);
  if (!token || !gistId) return;
  // FIXME: we will loose the bookmarkChanged state if the browser is closed before the sync
  // should we save it into storage?
  bookmarkChanged = true;
  scheduleSync();
}

async function createBookmark(bookmark) {
  if (USER_AGENT === 'chrome') {
    if (bookmark.type === 'folder') {
      bookmark.url = null;
    } else if (bookmark.type === 'separator') {
      bookmark.title = '-----------------';
      bookmark.url = 'about:blank';
    }
    delete bookmark.type;
  } else if (bookmark.type === "separator") {
    delete bookmark.title;
    delete bookmark.url;
  }
  return await browser.bookmarks.create(bookmark);
}

function scheduleSync(delayInMinutes = 1) {
  browser.alarms.create('sync', {
    periodInMinutes: 10,
    // NOTE: Firefox doesn't support delayInMinutes: 0?
    delayInMinutes
  });
}

