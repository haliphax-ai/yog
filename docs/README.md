# yog docs

Taxonomy: one directory per concern, `README.md` in each. Start here.

| Doc                                 | Concern                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| [contract](contract/README.md)      | The v1 HTTP/SSE wire contract: routes, message types, stream events, errors, sessions and dormancy. |
| [operations](operations/README.md)  | Running the daemon: CLI, configuration, Docker, state layout, environment requirements.             |
| [harness](harness/README.md)        | What agents get: the virtual filesystem, descriptors, the bash tool, skills, token accounting.      |
| [token-accuracy](token-accuracy.md) | Plan and incident analysis behind the token estimator and `yog calibrate`.                          |

The client side of the contract is implemented by
[yog-client-tui](https://github.com/haliphax-ai/yog-client-tui). The
dependency graph image lives on the `assets` branch; regenerate the Mermaid
source with `npm run depcruise:graph`.
