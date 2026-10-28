# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through [GitHub's private vulnerability reporting](https://github.com/teklumt/easy-ping/security/advisories/new), or email **main@easy-pings.com** with "security" in the subject.

Include the easy-ping version, the adapter and plugins involved, and the smallest setup that shows the problem. You will get a reply within 3 working days. Once a fix is released, the advisory is published with credit to you, unless you prefer to stay anonymous.

## Supported versions

easy-ping is pre-1.0. Fixes land in the latest minor release only, so upgrade to the newest `0.x` to receive them.

## Scope

In scope: everything published in the `easy-ping` npm package, including the route handler, adapters, plugins, providers and the browser, service worker and React clients.

Out of scope: the `examples/` apps, which deliberately trust a demo identity header or cookie and refuse to start in production, and misconfiguration the docs already warn about, such as a missing `cron.secret` or an untrusted proxy in front of the rate limiter.

The hardening the library already does is described on the [security page](https://easy-pings.com/docs/security).
