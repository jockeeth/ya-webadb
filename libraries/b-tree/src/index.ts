interface BTreeInsertionResult {
    key: number;
    child: BTreeNode;
}

function insert(array: Int32Array, length: number, value: number, index: number) {
    if (index !== length) {
        array.set(array.subarray(index, length), index + 1);
    }
    array[index] = value;
}

function remove(array: Int32Array, length: number, index: number) {
    if (index < length - 1) {
        array.set(array.subarray(index + 1, length), index);
    }
}

export class BTreeNode {
    order: number;
    mid: number;
    minKeyCount: number;

    keys: Int32Array;
    keyCount: number;

    height: number;
    children: BTreeNode[];

    public constructor(
        order: number,
        keys: Int32Array,
        keyCount: number,
        height: number,
        children: BTreeNode[]
    ) {
        this.order = order;
        this.mid = this.order >> 1;
        // Math.ceil(order / 2) - 1
        this.minKeyCount = ((this.order + 1) >> 1) - 1;

        this.keys = keys;
        this.keyCount = keyCount;

        this.height = height;
        this.children = children;
    }

    /**
     * Split the current node into two
     * @param value The key to be inserted.
     * @param index The index of the key to be inserted at.
     * @param child The child (right to the key) to be inserted. May be undefined when current node is a leaf.
     * @returns The new key and child need to be inserted to its parent.
     * The new key is the middle key of the current node, and the child contains the right half of the current node.
     */
    protected split(value: number, index: number, child?: BTreeNode): BTreeInsertionResult {
        let middleKey: number;
        const rightKeys = new Int32Array(this.order - 1);
        let rightChildren: BTreeNode[];

        if (index < this.mid) {
            middleKey = this.keys[this.mid - 1]!;
            rightKeys.set(this.keys.subarray(this.mid), 0);

            insert(this.keys, this.mid - 1, value, index);

            if (child) {
                // internal node
                rightChildren = this.children.splice(this.mid, this.order - this.mid);
                // TODO: this may cause the underlying array to grow (re-alloc and copy)
                // investigate if this hurts performance.
                this.children.splice(index + 1, 0, child);
            } else {
                // leaf node, doesn't have children, create am empty array for it.
                rightChildren = new Array(this.order);
            }
        } else {
            if (index === this.mid) {
                middleKey = value;
                rightKeys.set(this.keys.subarray(this.mid), 0);
            } else {
                middleKey = this.keys[this.mid]!;
                if (index !== this.mid + 1) {
                    rightKeys.set(this.keys.subarray(this.mid + 1, index), 0);
                }
                rightKeys[index - this.mid - 1] = value;
                rightKeys.set(this.keys.subarray(index), index - this.mid);
            }

            if (child) {
                rightChildren = this.children.splice(this.mid + 1, this.order - this.mid - 1);
                rightChildren.splice(index - this.mid, 0, child);
            } else {
                rightChildren = new Array(this.order);
            }
        }

        this.keyCount = this.mid;
        return {
            key: middleKey,
            child: new BTreeNode(
                this.order,
                rightKeys,
                this.order - 1 - this.mid,
                this.height,
                rightChildren
            ),
        };
    }

    public search(value: number): number {
        let start = 0;
        let end = this.keyCount - 1;
        while (start <= end) {
            const mid = (start + end) >> 1;
            if (this.keys[mid] === value) {
                return mid;
            } else if (this.keys[mid]! < value) {
                start = mid + 1;
            } else {
                end = mid - 1;
            }
        }
        return ~start;
    }

    public has(value: number): boolean {
        let index = this.search(value);
        if (index >= 0) {
            return true;
        }
        if (this.height > 0) {
            index = ~index;
            return this.children[index]!.has(value);
        }
        return false;
    }

    public insert(value: number): BTreeInsertionResult | boolean {
        let index = this.search(value);
        if (index >= 0) {
            return false;
        }

        index = ~index;

        if (this.height === 0) {
            if (this.keyCount === this.order - 1) {
                return this.split(value, index);
            }

            insert(this.keys, this.keyCount, value, index);
            this.keyCount += 1;
            return true;
        }

        const split = this.children[index]!.insert(value);
        if (typeof split === 'object') {
            if (this.keyCount === this.order - 1) {
                return this.split(split.key, index, split.child);
            }

            insert(this.keys, this.keyCount, split.key, index);
            this.keyCount += 1;

            this.children.splice(index + 1, 0, split.child);
        }

        return true;
    }

    public remove(value: number): boolean {
        let index = this.search(value);
        if (index >= 0) {
            this.removeAt(index);
            return true;
        }

        if (this.height > 0) {
            index = ~index;
            const removed = this.children[index]!.remove(value);
            if (removed) {
                this.balance(index);
            }
            return removed;
        }

        return false;
    }

    public max(): number {
        if (this.height === 0) {
            return this.keys[this.keyCount - 1]!;
        }
        return this.children[this.keyCount]!.max();
    }

    protected balance(index: number) {
        const child = this.children[index]!;

        if (child.keyCount >= this.minKeyCount) {
            return;
        }

        if (index > 0) {
            const left = this.children[index - 1]!;
            if (left.keyCount > this.minKeyCount) {
                // rotate right
                insert(child.keys, child.keyCount, this.keys[index - 1]!, 0);
                if (this.height > 1) {
                    child.children.splice(0, 0, left.children[left.keyCount]!);
                }
                child.keyCount += 1;

                this.keys[index - 1] = left.keys[left.keyCount - 1]!;
                left.keyCount -= 1;
                return;
            }

            // merge with left
            left.keys[left.keyCount] = this.keys[index - 1]!;
            left.keyCount += 1;
            left.keys.set(child.keys.subarray(0, child.keyCount), left.keyCount);
            if (this.height > 1) {
                for (let i = 0; i <= child.keyCount; i++) {
                    left.children[left.keyCount + i] = child.children[i]!;
                }
            }
            left.keyCount += child.keyCount;
            remove(this.keys, this.keyCount, index - 1);
            this.children.splice(index, 1);
            this.keyCount -= 1;
            return;
        }

        const right = this.children[index + 1]!;
        if (right.keyCount > this.minKeyCount) {
            // rotate left
            child.keys[child.keyCount] = this.keys[index]!;
            if (this.height > 1) {
                child.children[child.keyCount + 1] = right.children.splice(0, 1)[0]!;
            }
            child.keyCount += 1;

            this.keys[index] = right.keys[0]!;

            remove(right.keys, right.keyCount, 0);
            right.keyCount -= 1;
            return;
        }

        // merge right into child
        child.keys[child.keyCount] = this.keys[index]!;
        child.keyCount += 1;
        child.keys.set(right.keys.subarray(0, right.keyCount), child.keyCount);
        if (this.height > 1) {
            for (let i = 0; i <= right.keyCount; i++) {
                child.children[child.keyCount + i] = right.children[i]!;
            }
        }
        child.keyCount += right.keyCount;
        remove(this.keys, this.keyCount, index);
        this.children.splice(index + 1, 1);
        this.keyCount -= 1;
    }

    protected removeMax(): void {
        if (this.height === 0) {
            this.keyCount -= 1;
            return;
        }

        const child = this.children[this.keyCount]!;
        child.removeMax();
        this.balance(this.keyCount);
    }

    protected removeAt(index: number) {
        if (this.height === 0) {
            remove(this.keys, this.keyCount, index);
            this.keyCount -= 1;
            return;
        }

        const max = this.children[index]!.max();
        this.keys[index] = max;
        this.children[index]!.removeMax();
        this.balance(index);
    }
}

export class BTree {
    order: number;
    root: BTreeNode;

    size: number = 0;

    public constructor(order: number) {
        this.order = order;
        this.root = new BTreeNode(
            order,
            new Int32Array(order - 1),
            0,
            0,
            new Array(order)
        );
    }

    public has(value: number) {
        // TODO(btree): benchmark this non-recursive version
        let node = this.root;
        while (true) {
            const index = node.search(value);
            if (index >= 0) {
                return true;
            }

            node = node.children[~index]!;
            if (!node) {
                return false;
            }
        }
    }

    public insert(value: number) {
        const split = this.root.insert(value);
        if (typeof split === 'object') {
            const keys = new Int32Array(this.order - 1);
            keys[0] = split.key;

            const children = new Array(this.order);
            children[0] = this.root;
            children[1] = split.child;

            this.root = new BTreeNode(
                this.order,
                keys,
                1,
                this.root.height + 1,
                children
            );
        }
        if (split) {
            this.size += 1;
        }
        return !!split;
    }

    public remove(value: number) {
        const removed = this.root.remove(value);
        if (removed) {
            if (this.root.height > 0 && this.root.keyCount === 0) {
                this.root = this.root.children[0]!;
            }
            this.size -= 1;
        }
        return removed;
    }
}
