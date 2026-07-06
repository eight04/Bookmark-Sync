import treeDiffer from "treediffer";

import {builtinIds, NATIVE_ID, USER_AGENT} from "./env.js";

const OP_CHANGE_TO = Symbol();
const OP_INSERT_AFTER = Symbol();
const OP_INSERT_CHILD = Symbol();
const OP_REMOVE = Symbol();
const OP_MOVE_FROM = Symbol();
const OP_MOVE_TO = Symbol();
const ORIGIN = Symbol();
const CORRESPONDS = Symbol();

export function createDiffer(baseData, keys) {
  keys = keys || Object.keys(builtinIds).filter(key => builtinIds[key][USER_AGENT] != null);
  const baseTree = new treeDiffer.Tree(makeRoot(baseData, keys), BookmarkTreeNode);
  const diffs = [];
  let generated = false;

  return {
    diff(newData) {
      if (generated) {
        throw new Error("Patch has already been generated");
      }
      const newTree = new treeDiffer.Tree(makeRoot(newData, keys), BookmarkTreeNode);
      const differ = new treeDiffer.Differ(baseTree, newTree);
      const trans = differ.transactions[baseTree.orderedNodes.length - 1][newTree.orderedNodes.length - 1];
      const op = differ.getCorrespondingNodes(trans, baseTree.orderedNodes.length, newTree.orderedNodes.length);
      detectIllegalChanges(op, baseTree, newTree);
      detectMoves(op, baseTree, newTree);
      diffs.push({trans, op, tree: newTree, size: trans.length});
      return this;
    },
    generatePatch() {
      if (generated) {
        throw new Error("Patch has already been generated");
      }
      generated = true;
      for (const {op, tree, size} of diffs) {
        if (!size) {
          continue;
        }
        annotateTransaction({
          tree1: baseTree,
          tree2: tree,
          op,
        });
      }
      return resolveNode(baseTree.root, baseTree.root, {index: 0});
    }
  };
}

function* resolveNode(node, origin = node, ctx) {
  if (node[CORRESPONDS]) {
    const l = node[CORRESPONDS];
    delete node[CORRESPONDS];
    for (const n of new Set(l)) {
      yield* resolveNode(n, origin, ctx);
    }
  }
  if (node[OP_CHANGE_TO]) {
    const value = node[OP_CHANGE_TO];
    delete node[OP_CHANGE_TO];
    yield {op: "replace", node: origin, value};
    yield *resolveNode(value, origin, ctx);
  }
  if (node[OP_INSERT_AFTER]) {
    const l = node[OP_INSERT_AFTER];
    delete node[OP_INSERT_AFTER];
    ctx.indexBeforeInsert = ctx.index;
    for (const value of l) {
      ctx.index++;
      if (value[OP_MOVE_FROM]) {
        yield {op: "move", from: value[OP_MOVE_FROM], parent: origin.parent, index: ctx.index};
        origin.parent.children.splice(ctx.index, 0, value);
        value.parent = origin.parent;
        const oldIndex = value[OP_MOVE_FROM].parent.children.indexOf(value[OP_MOVE_FROM]);
        if (value[OP_MOVE_FROM].parent.ctx?.index >= oldIndex) {
          value[OP_MOVE_FROM].parent.ctx.index--;
          value[OP_MOVE_FROM].parent.children.splice(oldIndex, 1);
        }
        yield *resolveNode(value[OP_MOVE_FROM], value, ctx);
        delete value[OP_MOVE_FROM];
      } else {
        yield {op: "add", parent: origin.parent, index: ctx.index, value};
        origin.parent.children.splice(ctx.index, 0, value);
        value.parent = origin.parent;
      }
      yield *resolveNode(value, value, ctx);
    }
  }
  if (node[OP_MOVE_TO]) {
    // delay the resolve to the target node, just skip
    delete node[OP_MOVE_TO];
    // ctx.index--;
    return;
  }
  if (node[OP_REMOVE]) {
    yield {op: "remove", value: origin};
    // should be handled by OP_MOVE_FROM of the target node, just skip
    delete node[OP_REMOVE];
    ctx.index--;
    return;
  } 
  const childCtx = {index: 0};
  const children = node.children.slice();
  origin.ctx = childCtx;
  if (node[OP_INSERT_CHILD]) {
    const l = node[OP_INSERT_CHILD];
    delete node[OP_INSERT_CHILD];
    for (const value of l) {
      if (value[OP_MOVE_FROM]) {
        // console.log("insert child move", value, value[OP_MOVE_FROM]);
        yield {op: "move", from: value[OP_MOVE_FROM], parent: origin, index: childCtx.index};
        // FIXME: avoid resolving the same child multiple times
        origin.children.splice(childCtx.index, 0, value);
        value.parent = origin;
        const oldIndex = value[OP_MOVE_FROM].parent.children.indexOf(value[OP_MOVE_FROM]);
        if (value[OP_MOVE_FROM].parent.ctx?.index >= oldIndex) {
          value[OP_MOVE_FROM].parent.ctx.index--;
          value[OP_MOVE_FROM].parent.children.splice(oldIndex, 1);
        }
        yield *resolveNode(value[OP_MOVE_FROM], value, childCtx);
        delete value[OP_MOVE_FROM];
      } else {
        yield {op: "add", parent: origin, index: childCtx.index, value};
      }
      yield *resolveNode(value, value, childCtx);
      childCtx.index++;
    }
  }
  for (const n of children) {
    yield* resolveNode(n, n, childCtx);
    childCtx.index++;
  }
}

function detectIllegalChanges(op, tree1, tree2) {
  for (const [i, j] of Object.entries(op.change)) {
    const leftNode = tree1.orderedNodes[i];
    const rightNode = tree2.orderedNodes[j];
    if (!leftNode.isModifiedOf(rightNode)) {
      delete op.change[i];
      op.insert.push(j);
      op.remove.push(i);
    }
  }
}

function detectMoves(op, tree1, tree2) {
  const moved = [];
  op.moved = moved;
  for (let i = 0; i < op.remove.length; i++) {
    const leftIndex = op.remove[i];
    for (let j = 0; j < op.insert.length; j++) {
      const rightIndex = op.insert[j];
      const fromNode = tree1.orderedNodes[leftIndex];
      const toNode = tree2.orderedNodes[rightIndex];
      if (fromNode.isEqual(toNode)) {
        moved.push([leftIndex, rightIndex]);
        op.insert.splice(j, 1);
        op.remove.splice(i, 1);
        i--;
        break;
      }
      if (fromNode.isModifiedOf(toNode)) {
        moved.push([leftIndex, rightIndex]);
        op.change[leftIndex] = rightIndex;
        op.insert.splice(j, 1);
        op.remove.splice(i, 1);
        i--;
        break;
      }
    }
  }
}

function annotateTransaction(trans) {
  // annotate changes
  for (const [i, j] of Object.entries(trans.op.change)) {
    const n1 = trans.tree1.orderedNodes[i];
    const n2 = trans.tree2.orderedNodes[j];
    if (!n1[OP_CHANGE_TO]) {
      n1[OP_CHANGE_TO] = n2;
      // n2[OP_CHANGE_TO] = n1;
    } else {
      // FIXME: when there are multiple changes to the same node, treat second change as insert?
      if (!n1[OP_INSERT_AFTER]) {
        n1[OP_INSERT_AFTER] = [];
      }
      n1[OP_INSERT_AFTER].push(n2);
    }
  }
  // annotate removes
  for (const i of trans.op.remove) {
    const n = trans.tree1.orderedNodes[i];
    n[OP_REMOVE] = true;
    if (!n[OP_INSERT_AFTER]) {
      n[OP_INSERT_AFTER] = [];
    }
    for (const c of n.children) {
      const rightIndex = trans.op.oldToNew[c.index];
      if (rightIndex !== undefined) {
        const rightNode = trans.tree2.orderedNodes[rightIndex];
        n[OP_INSERT_AFTER].push(rightNode);
        rightNode[OP_MOVE_FROM] = c;
        c[OP_MOVE_TO] = rightNode;
      }
    }
  }
  // annotate inserts
  for (const i of trans.op.insert) {
    const treeNode = trans.tree2.orderedNodes[i];
    annotateInsert(treeNode, trans);
  }
  // annotate moves
  for (const [fromIndex, toIndex] of trans.op.moved) {
    let fromNode = trans.tree1.orderedNodes[fromIndex];
    const toNode = trans.tree2.orderedNodes[toIndex];
    // concat move chain
    while (fromNode[OP_MOVE_TO]) {
      fromNode = fromNode[OP_MOVE_TO];
    }
    if (fromNode === toNode) {
      continue;
    }
    fromNode[OP_MOVE_TO] = toNode;
    toNode[OP_MOVE_FROM] = fromNode;
    // insert
    annotateInsert(toNode, trans);
  }
}

function annotateOrigin(node, trans) {
  const leftIndex = trans.op.newToOld[node.index];
  if (leftIndex !== undefined) {
    const leftNode = trans.tree1.orderedNodes[leftIndex];
    node[ORIGIN] = leftNode;
    if (!leftNode[CORRESPONDS]) {
      leftNode[CORRESPONDS] = [];
    }
    // NOTE: corresponds may contain duplicates, make sure to filter out later.
    leftNode[CORRESPONDS].push(node);
  }
}

function annotateInsert(node, trans) {
  calculatePrev(node);
  if (node.prev) {
    annotateOrigin(node.prev, trans);
    const preNode = node.prev;
    if (!preNode[OP_INSERT_AFTER]) {
      preNode[OP_INSERT_AFTER] = [];
    }
    preNode[OP_INSERT_AFTER].push(node);
  } else {
    annotateOrigin(node.parent, trans);
    const parentNode = node.parent;
    if (!parentNode[OP_INSERT_CHILD]) {
      parentNode[OP_INSERT_CHILD] = [];
    }
    parentNode[OP_INSERT_CHILD].push(node);
  }
}

function calculatePrev(node) {
  const parent = node.parent;
  if (parent.children.length >= 2 && parent.children[1].prev) {
    return;
  }
  for (let i = 1; i < parent.children.length; i++) {
    parent.children[i].prev = parent.children[i - 1];
  }
}

function makeRoot(data, keys) {
  return {
    type: "root",
    children: keys.map(key => ({
      type: "category",
      id: key,
      [NATIVE_ID]: builtinIds[key][USER_AGENT],
      children: data[key] || []
    }))
  };
}

class BookmarkTreeNode extends treeDiffer.TreeNode {
  getOriginalNodeChildren() {
    return this.node.children || [];
  }
  isEqual(otherNode) {
    if (this.node.type !== otherNode.node.type) return false;
    if (this.node.type === "category") {
      return this.node.id === otherNode.node.id;
    }
    if (this.node.type === "folder") {
      return this.node.title === otherNode.node.title;
    }
    if (this.node.type === "separator" || this.node.type === "root") {
      return true;
    }
    if (this.node.type === "bookmark") {
      return this.node.url === otherNode.node.url && this.node.title === otherNode.node.title;
    }
    throw new Error("Unknown node type: " + this.node.type);
  }
  isModifiedOf(otherNode) {
    const a = this.node;
    const b = otherNode.node;
    if (a.type !== b.type) return false;
    if (a.type === "category") {
      return a.id === b.id;
    }
    if (a.type === "bookmark") {
      return a.url === b.url || a.title === b.title;
    }
    if (a.type === "folder") {
      return true;
    }
    return false;
  }
}
