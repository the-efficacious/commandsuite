---
"csuite-sdk": minor
"csuite-core": minor
"csuite-cli": minor
"csuite-web-ui": patch
---

Runners now receive a targeted `environment` stream event when a bound secret or variable changes, drain at idle, refresh their resolved environment through the broker, and resume the same conversation. `context_control reload` triggers the same refresh explicitly, while `--no-env-reload` disables only automatic environment restarts. New secret values are registered with the additive redactor before the successor agent starts; a failed refresh keeps the prior environment.
