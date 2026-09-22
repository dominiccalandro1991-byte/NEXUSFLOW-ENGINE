# Complexity model

P = active price levels, M = consumed resting orders, L = emptied levels.

| Operation | Bound |
|---|---|
| Best bid / ask | O(1) cached extrema |
| Insert | O(log P) |
| Cancel | O(1) index + O(1) unlink; O(log P) if the level empties |
| Match | O(M + L log P) |
| Per consumed resting order | amortized O(1) book-node work |

Not claimed:

- Unconditional O(1) total market matching
- Lock-free shared-memory semantics in ordinary JavaScript
- Real-world latency guarantees derived from Big-O

JavaScript provides a single-threaded event loop. Matching state is mutated on one writer path with an explicit sequence number.
