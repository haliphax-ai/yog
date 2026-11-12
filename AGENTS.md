# AGENTS.md

## Small, liberal API surface

This system has an intentionally small API surface. A spare few endpoints are
available, because the primary method of information transfer between the
server and client take place in the message contract, not the endpoints
themselves. This is not a strict REST API.

## Progressive provider enhancement

OpenRouter (`openrouter.ai`, `*.openrouter.ai`) provides a great deal of
features and information that the base OpenAI-compatible API spec does not.
Features in this system must never _rely_ on OpenRouter-specific data or
endpoints to operate unless specified. The base OpenAI-compatible spec is
followed; OpenRouter's feature set may progressively enhance the
experience, but not be a requirement.
