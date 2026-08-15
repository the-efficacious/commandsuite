---
'csuite-core': minor
'csuite-cli': minor
'csuite-server': minor
---

**Breaking.** One structured logger across the broker, CLI and runner: every process now emits `{ts, level, component, msg, ...context}` as one JSON line, with a `CSUITE_LOG_LEVEL` threshold. Runner logs previously carried no severity at all, and the broker's `BrokerLogger` defaulted to a no-op that discarded subscriber warnings.

`BrokerLogger` is no longer exported from `csuite-core`; `Broker`, the MCP client manager and the gen-ai correlator all take the standard `Logger`, and the correlator's `log` option is now `logger`.
