/**
 * AVL price tree with cached extrema.
 *
 * insert / remove: O(log P)
 * get: O(log P)
 * min / max lookup: O(1) via cached pointers (refreshed in O(log P) on mutation)
 *
 * P = number of active price levels.
 */
export class AvlNode<T> {
  h = 1;
  l: AvlNode<T> | null = null;
  r: AvlNode<T> | null = null;
  key: number;
  value: T;
  constructor(key: number, value: T) {
    this.key = key;
    this.value = value;
  }
}

export class AvlPriceTree<T> {
  root: AvlNode<T> | null = null;
  private minNode: AvlNode<T> | null = null;
  private maxNode: AvlNode<T> | null = null;
  size = 0;

  min(): AvlNode<T> | null {
    return this.minNode;
  }

  max(): AvlNode<T> | null {
    return this.maxNode;
  }

  get(key: number): T | null {
    let n = this.root;
    while (n) {
      if (key === n.key) return n.value;
      n = key < n.key ? n.l : n.r;
    }
    return null;
  }

  insert(key: number, value: T): void {
    if (this.get(key) !== null) return;
    this.root = this.insertNode(this.root, key, value);
    this.size += 1;
    this.refreshExtrema();
  }

  remove(key: number): void {
    if (this.get(key) === null) return;
    this.root = this.removeNode(this.root, key);
    this.size -= 1;
    this.refreshExtrema();
  }

  private height(n: AvlNode<T> | null): number {
    return n?.h ?? 0;
  }

  private fix(n: AvlNode<T>): void {
    n.h = 1 + Math.max(this.height(n.l), this.height(n.r));
  }

  private rotateR(y: AvlNode<T>): AvlNode<T> {
    const x = y.l!;
    y.l = x.r;
    x.r = y;
    this.fix(y);
    this.fix(x);
    return x;
  }

  private rotateL(x: AvlNode<T>): AvlNode<T> {
    const y = x.r!;
    x.r = y.l;
    y.l = x;
    this.fix(x);
    this.fix(y);
    return y;
  }

  private rebalance(n: AvlNode<T>, key: number): AvlNode<T> {
    this.fix(n);
    const b = this.height(n.l) - this.height(n.r);
    if (b > 1) {
      if (key < n.l!.key) return this.rotateR(n);
      n.l = this.rotateL(n.l!);
      return this.rotateR(n);
    }
    if (b < -1) {
      if (key > n.r!.key) return this.rotateL(n);
      n.r = this.rotateR(n.r!);
      return this.rotateL(n);
    }
    return n;
  }

  private rebalanceDelete(n: AvlNode<T>): AvlNode<T> {
    this.fix(n);
    const b = this.height(n.l) - this.height(n.r);
    if (b > 1) {
      if (this.height(n.l!.r) > this.height(n.l!.l)) n.l = this.rotateL(n.l!);
      return this.rotateR(n);
    }
    if (b < -1) {
      if (this.height(n.r!.l) > this.height(n.r!.r)) n.r = this.rotateR(n.r!);
      return this.rotateL(n);
    }
    return n;
  }

  private insertNode(n: AvlNode<T> | null, key: number, value: T): AvlNode<T> {
    if (!n) return new AvlNode(key, value);
    if (key < n.key) n.l = this.insertNode(n.l, key, value);
    else if (key > n.key) n.r = this.insertNode(n.r, key, value);
    else {
      n.value = value;
      return n;
    }
    return this.rebalance(n, key);
  }

  private minOf(n: AvlNode<T>): AvlNode<T> {
    while (n.l) n = n.l;
    return n;
  }

  private removeNode(n: AvlNode<T> | null, key: number): AvlNode<T> | null {
    if (!n) return null;
    if (key < n.key) n.l = this.removeNode(n.l, key);
    else if (key > n.key) n.r = this.removeNode(n.r, key);
    else {
      if (!n.l) return n.r;
      if (!n.r) return n.l;
      const s = this.minOf(n.r);
      n.key = s.key;
      n.value = s.value;
      n.r = this.removeNode(n.r, s.key);
    }
    return this.rebalanceDelete(n);
  }

  private refreshExtrema(): void {
    let lo = this.root;
    let hi = this.root;
    while (lo?.l) lo = lo.l;
    while (hi?.r) hi = hi.r;
    this.minNode = lo;
    this.maxNode = hi;
  }

  collectDesc(limit = 32): Array<{ key: number; value: T }> {
    const out: Array<{ key: number; value: T }> = [];
    const walk = (n: AvlNode<T> | null) => {
      if (!n || out.length >= limit) return;
      walk(n.r);
      if (out.length < limit) out.push({ key: n.key, value: n.value });
      walk(n.l);
    };
    walk(this.root);
    return out;
  }

  collectAsc(limit = 32): Array<{ key: number; value: T }> {
    const out: Array<{ key: number; value: T }> = [];
    const walk = (n: AvlNode<T> | null) => {
      if (!n || out.length >= limit) return;
      walk(n.l);
      if (out.length < limit) out.push({ key: n.key, value: n.value });
      walk(n.r);
    };
    walk(this.root);
    return out;
  }
}
