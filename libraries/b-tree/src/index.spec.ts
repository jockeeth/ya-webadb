import { describe, expect, it } from '@jest/globals';
import { BTree, BTreeNode } from "./index.js";

const LENGTH = 128;

function shuffle<T>(array: T[]) {
    for (let i = array.length - 1; i > 0; i -= 1) {
        const j = (Math.random() * (i + 1)) | 0;
        [array[i], array[j]] = [array[j]!, array[i]!];
    }
}

describe('BTree', () => {
    for (let order = 3; order < 10; order += 1) {
        // Math.ceil(order / 2) - 1
        const MIN_KEY_COUNT = ((order + 1) >> 1) - 1;

        function validateNode(node: BTreeNode, root: boolean, min = -Infinity) {
            if (node.height === 0) {
                expect(node.keyCount).toBeGreaterThan(0);
                expect(node.keyCount).toBeLessThan(order);
                for (let i = 0; i < node.keyCount; i += 1) {
                    expect(node.keys[i]).toBeGreaterThan(min);
                    min = node.keys[i]!;
                }
                return min;
            }

            if (!root) {
                expect(node.keyCount).toBeGreaterThanOrEqual(MIN_KEY_COUNT);
            }
            expect(node.keyCount).toBeLessThan(order);

            for (let i = 0; i < node.keyCount; i += 1) {
                min = validateNode(node.children[i]!, false, min);
                expect(node.keys[i]).toBeGreaterThan(min);
                min = node.keys[i]!;
            }
            min = validateNode(node.children[node.keyCount]!, false, min);
            return min;
        }

        function validateTree(tree: BTree) {
            if (tree.size === 0) {
                expect(tree.root.keyCount).toBe(0);
                return;
            }

            validateNode(tree.root, true);
        }

        describe(`order ${order}`, () => {
            it('should generate valid tree with incremental values', () => {
                const tree = new BTree(order);

                const values = Array.from({ length: LENGTH }, (_, i) => i - LENGTH / 2);
                for (let value of values) {
                    tree.insert(value);
                    validateTree(tree);
                    expect(tree.has(value)).toBe(true);
                }

                for (let value of values) {
                    tree.remove(value);
                    validateTree(tree);
                    expect(tree.has(value)).toBe(false);
                }
            });

            it('should generate valid tree with random values', () => {
                const tree = new BTree(order);

                const values = Array.from({ length: LENGTH }, (_, i) => i - LENGTH / 2);
                shuffle(values);
                for (const value of values) {
                    tree.insert(value);
                    validateTree(tree);
                    expect(tree.has(value)).toBe(true);
                }

                shuffle(values);
                for (const value of values) {
                    tree.remove(value);
                    validateTree(tree);
                    expect(tree.has(value)).toBe(false);
                }
            });
        });
    }
});
