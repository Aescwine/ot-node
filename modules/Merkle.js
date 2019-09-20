const abi = require('ethereumjs-abi');
const BN = require('bn.js');
const Utilities = require('./Utilities');
const { sha3_256 } = require('js-sha3');

class MerkleTree {
    generateLeafHash(leaf, index) {
        switch (this.hashFunction) {
        case 'soliditySha3':
            if (Buffer.from(`${leaf}`, 'utf8').byteLength > 32) {
                throw Error('Block size is larger than 32 bytes.');
            }
            return abi.soliditySHA3(
                ['bytes32', 'uint256'],
                [Utilities.normalizeHex(Buffer.from(`${leaf}`, 'utf8').toString('hex')), index],
            ).toString('hex');

        case 'sha3': return sha3_256(`${leaf}${index}`);
        default: throw Error('Invalid hash function!');
        }
    }

    generateInternalHash(block1, block2) {
        switch (this.hashFunction) {
        case 'soliditySha3':
            return abi.soliditySHA3(
                ['bytes32', 'bytes32'],
                [
                    Utilities.normalizeHex(`${block1}`),
                    Utilities.normalizeHex(`${block2}`),
                ],
            ).toString('hex');

        case 'sha3': return sha3_256(`${Utilities.normalizeHex(block1)}${Utilities.normalizeHex(block2)}`);
        default: throw Error('Invalid hash function!');
        }
    }

    constructor(leaves, hashFunction = 'soliditySha3') {
        this.levels = [];
        this.levels.push(leaves);
        this.hashFunction = hashFunction;
        const leavesHashes = [];
        for (let i = 0; i < leaves.length; i += 1) {
            const hash = this.generateLeafHash(leaves[i], i);

            leavesHashes.push(hash);
        }

        this.levels.push(leavesHashes);

        let nextLevel = [];
        let currentLevel = leavesHashes;
        do {
            nextLevel = [];
            let i = 0;
            while (i < currentLevel.length) {
                if (i + 1 < currentLevel.length) {
                    const hash = this.generateInternalHash(
                        currentLevel[i],
                        currentLevel[i + 1],
                    );
                    nextLevel.push(hash);
                } else {
                    const hash = this.generateInternalHash(
                        currentLevel[i],
                        currentLevel[i],
                    );
                    nextLevel.push(hash);
                }
                i += 2;
            }
            this.levels.push(nextLevel);
            currentLevel = nextLevel;
        } while (currentLevel.length > 1);

        [this.rootHash] = currentLevel;
    }

    getRoot() {
        return `0x${this.rootHash}`;
    }

    createProof(leafNumber) {
        const { levels } = this;

        let currentLevel = 1;

        const proof = [];

        let i = leafNumber;

        while (currentLevel < levels.length - 1) {
            if (i % 2 === 1) {
                proof.push(`0x${levels[currentLevel][i - 1]}`);
            } else if ((i + 1) < levels[currentLevel].length) {
                proof.push(`0x${levels[currentLevel][i + 1]}`);
            } else {
                proof.push(`0x${levels[currentLevel][i]}`);
            }

            currentLevel += 1;
            i = Math.trunc(i / 2);
        }

        return proof;
    }

    verifyProof(proof, block, i) {
        let h = this.generateLeafHash(block, i);
        let j = this.levels.length - 1;
        let k = 0;
        let r = 0;

        while (j > 1) {
            r = i % 2;
            if (r % 2 === 0) {
                h = this.generateInternalHash(h, proof[k]);
            } else {
                h = this.generateInternalHash(proof[k], h);
            }

            k += 1;
            i = Math.trunc(i / 2);
            j -= 1;
        }
        return h === this.rootHash;
    }
}

module.exports = MerkleTree;
