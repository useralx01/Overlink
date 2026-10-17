# Development status

**Source release:** Overlink v0.4.1 (developer preview).

| Area | Status |
| --- | --- |
| Legacy PC Link remote-control tools | Implemented and validated in a controlled environment |
| Windows application | Built and integration-tested on two Windows PCs |
| Windowless automatic startup | No child console allocated and no new visible terminals observed during checks on two PCs |
| Startup recovery | Per-user login plus five-minute fallback/retry; controller singleton, explicit stop/resume and temporary runtime recovery tested |
| Cross-PC synthetic file transfer | Tested both directions, including SHA-256 verification |
| Synthetic Codex session handoff | Tested both directions |
| Local workflow batching | Implemented and benchmarked |
| Windows system health metrics | Tested locally on two machines |
| Permission-gated process termination | Unauthorized requests rejected; do not treat recovery as fully production-tested |
| Hosted MCP server and dashboard | Built for an authenticated Site deployment |
| Public multi-user login / OAuth | Not implemented |
| End-to-end encrypted transfers | Not implemented |
| Native running-process migration | Not implemented |
| Signed automatic desktop updates | Not implemented |
| Public ChatGPT plugin listing | Not published as a general public integration |

### Benchmark qualification

A local Windows microbenchmark measured a **12.55× lower elapsed time** for twelve small file reads batched into a single workflow compared with twelve separately launched Python processes. This measures local process/round-trip overhead, **not** an overall GPT-vs-Codex speed improvement.

### Deployment note

A running private installation, if any, is separate from this source repository. Cloning this repository does not pair machines, deploy secrets, obtain site ownership, or grant access to any existing user's computers.
