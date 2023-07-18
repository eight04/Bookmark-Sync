/* eslint-env webextensions */
const USER_AGENT = navigator.userAgent.match(/Firefox/) ? "firefox" : "chrome";

const builtinIds = {
  // root: {
  //   chrome: "0",
  //   firefox: "root________"
  // },
  toolbar: {
    chrome: "1",
    firefox: "toolbar_____"
  },
  other: {
    // FIXME: it seems that vivaldi doesn't have "other bookmarks"?
    chrome: "2",
    firefox: "unfiled_____"
  },
  mobile: {
    chrome: null,
    firefox: "mobile______"
  },
  menu: {
    chrome: null,
    firefox: "menu________"
  }
}

let running = false;

async function sync() {
  if (running) {
    scheduleSync();
    return;
  }
  running = true;
  try {
    await _sync();
  } catch (e) {
    console.error(e);
  }
  running = false;
}

async function _sync() {
  let {token, lastUpdate, gistId} = await browser.storage.local.get(['token', 'lastUpdate', 'gistId']);
  if (!token) {
    throw new Error("You are not logged in");
  }
  if (!gistId) {
    throw new Error("Gist ID is not set");
  }
  const rr = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'GET',
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${token}`
    },
  })
  const r = await rr.json();
  if (r.truncated) {
    throw new Error("Gist content is too large");
  }
  const remoteData = r.files['bookmark.json'] ? JSON.parse(r.files['bookmark.json'].content) : null;
  if (remoteData && (remoteData.lastUpdate > lastUpdate || !lastUpdate)) {
    await patchBookmark(remoteData);
    await browser.storage.local.set({lastUpdate: remoteData.lastUpdate});
  } else if (!remoteData || lastUpdate > remoteData.lastUpdate) {
    if (!lastUpdate) {
      lastUpdate = Date.now();
      await browser.storage.local.set({lastUpdate});
    }
    await patchGist(await getBookmarkData(lastUpdate), token, gistId);
  }
}

async function getBookmarkData(lastUpdate) {
  const data = {
    lastUpdate,
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
  await fetch(`https://api.github.com/gists/${gistId}`, {
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
}

async function patchBookmark(remote) {
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

async function patchBookmarkFolder(local, remote, parentId) {
  let i = 0, j = 0;
  for (; i < local.length && j < remote.length;) {
    if (isSameBookmark(local[i], remote[j])) {
      if (local[i].children) {
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
      j++;
      if (remote[j].children) {
        await patchBookmarkFolder(r.children || [], remote[j].children, r.id);
      }
      continue;
    }
    // local[i] is deleted
    // remoteTree can also remove a single bookmark
    await browser.bookmarks.removeTree(local[i].id);
    i++;
    continue;
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
    
browser.bookmarks.onCreated.addListener(onBookmarkChanged)
browser.bookmarks.onRemoved.addListener(onBookmarkChanged)
browser.bookmarks.onChanged.addListener(onBookmarkChanged)
browser.bookmarks.onMoved.addListener(onBookmarkChanged)
browser.storage.onChanged.addListener(changes => {
  if (changes.token || changes.gistId) {
    scheduleSync(0);
  }
});

async function onBookmarkChanged() {
  // FIXME: need a more reliable way to determine if the user is editing bookmarks
  if (!running) {
    await browser.storage.local.set({lastUpdate: Date.now()});
  }
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
    delayInMinutes
  });
}

scheduleSync();

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'sync') {
    sync().catch(e => console.error(e));
  }
});
