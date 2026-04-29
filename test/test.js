import test from "node:test";
import assert from "node:assert/strict";

import {createDiffer} from "../src/lib/differ.js";
import {builtinIds} from "../src/lib/env.js";

const KEYS = Object.keys(builtinIds);

test("3-way diff", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Google", url: "https://www.google.com/", type: "bookmark"},
      {id: "2", title: "GitHub", url: "https://www.github.com/", type: "bookmark"}
    ],
    menu: [
      {id: "3", title: "StackOverflow", url: "https://stackoverflow.com/", type: "bookmark"},
    ]
  };
  const data2 = {
    toolbar: [
      {id: "1", title: "Google", url: "https://www.google.com/", type: "bookmark"},
      {id: "2", title: "GitHub", url: "https://www.github.com/", type: "bookmark"},
      {id: "4", title: "MDN Web Docs", url: "https://developer.mozilla.org/", type: "bookmark"}
    ],
    menu: [
      {id: "3", title: "StackOverflow", url: "https://stackoverflow.com/", type: "bookmark"},
      {id: "5", title: "Reddit", url: "https://www.reddit.com/", type: "bookmark"}
    ]
  };
  const data3 = {
    toolbar: [
      {id: "1", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
    ],
    menu: [
      {id: "3", title: "StackOverflow", url: "https://stackoverflow.com/", type: "bookmark"},
      {id: "6", title: "Hacker News", url: "https://news.ycombinator.com/", type: "bookmark"},
      {id: "2", title: "GitHub", url: "https://www.github.com/", type: "bookmark"},
    ]
  };
  const expectedPatch = [
    {op: "replace", node: "1", value: {id: "1", title: "Google Search", url: "https://www.google.com/", type: "bookmark"}},
    {op: "add", parent: "toolbar", index: 2, value: {id: "4", title: "MDN Web Docs", url: "https://developer.mozilla.org/", type: "bookmark"}},
    {op: "add", parent: "menu", index: 1, value: {id: "5", title: "Reddit", url: "https://www.reddit.com/", type: "bookmark"}},
    {op: "add", parent: "menu", index: 2, value: {id: "6", title: "Hacker News", url: "https://news.ycombinator.com/", type:
  "bookmark"}},
    {op: "move", from: "2", parent: "menu", index: 3}
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).diff(data3).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

test("folders", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Folder 1", type: "folder", children: [
      ]},
    ],
    menu: [
      {id: "3", title: "StackOverflow", url: "https://stackoverflow.com/", type: "bookmark"},
    ]
  };
  const data2 = {
    toolbar: [
      {id: "1", title: "Folder 1", type: "folder", children: [
        {id: "2", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
      ]},
    ],
  };
  const expectedPatch = [
    {op: "add", parent: "1", index: 0, value: {id: "2", title: "Google Search", url: "https://www.google.com/", type: "bookmark"}},
    {op: "remove", value: {id: "3", title: "StackOverflow", url: "https://stackoverflow.com/", type: "bookmark"}},
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

test("move to empty folder", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
    ],
    menu: [
    ]
  };
  const data2 = {
    toolbar: [
    ],
    menu: [
      {id: "1", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
    ]
  };
  const expectedPatch = [
    {op: "move", from: "1", parent: "menu", index: 0}
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

test("bookmark replaced by separator", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
    ],
  };
  const data2 = {
    toolbar: [
      {id: "2", type: "separator"},
    ],
  };
  const expectedPatch = [
    {op: "add", parent: "toolbar", index: 1, value: {id: "2", type: "separator"}},
    {op: "remove", value: {id: "1", title: "Google Search", url: "https://www.google.com/", type: "bookmark"}},
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

test("3-way change", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
    ],
  };
  const data2 = {
    toolbar: [
      {id: "1", title: "Google Search", url: "https://www.google.com.tw/", type: "bookmark"},
    ],
  };
  const data3 = {
    toolbar: [
      {id: "1", title: "Google Search", url: "https://www.google.com/search", type: "bookmark"},
    ],
  };
  const expectedPatch = [
    {op: "replace", node: "1", value: {id: "1", title: "Google Search", url: "https://www.google.com.tw/", type: "bookmark"}},
    {op: "add", parent: "toolbar", index: 1, value: {id: "1", title: "Google Search", url: "https://www.google.com/search", type: "bookmark"}},
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).diff(data3).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

test("remove tree", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Folder 1", type: "folder", children: [
        {id: "2", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
      ]},
    ],
  };
  const data2 = {
    toolbar: [
    ],
  };
  const expectedPatch = [
    {op: "remove", value: {id: "1", title: "Folder 1", type: "folder"}},
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

test("folder rename", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Folder 1", type: "folder", children: [
        {id: "2", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
      ]},
    ],
  };
  const data2 = {
    toolbar: [
      {id: "1", title: "Folder 2", type: "folder", children: [
        {id: "2", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
      ]},
    ],
  };
  const expectedPatch = [
    {op: "replace", node: "1", value: {id: "1", title: "Folder 2", type: "folder"}},
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

test("move bookmark out of folder", () => {
  const data1 = {
    toolbar: [
      {id: "1", title: "Folder 1", type: "folder", children: [
        {id: "2", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
      ]},
    ],
  };
  const data2 = {
    toolbar: [
      {id: "2", title: "Google Search", url: "https://www.google.com/", type: "bookmark"},
    ],
  };
  const expectedPatch = [
    {op: "move", from: "2", parent: "toolbar", index: 1},
  ];

  const differ = createDiffer(data1, KEYS);
  const patch = differ.diff(data2).generatePatch();
  assert.deepEqual(unwrapPatch(patch), expectedPatch);
});

function unwrapPatch(patch) {
  return [...patch].map(op => {
    const r = {...op};
    if (r.parent) {
      r.parent = r.parent.node.id;
    }
    if (r.node) {
      r.node = r.node.node.id;
    }
    if (r.from) {
      r.from = r.from.node.id;
    }
    if (r.value) {
      r.value = {...r.value.node};
      delete r.value.children
    }
    return r;
  });
}
