---
"easy-ping": patch
---

Stop shipping source maps. The build is not minified, so stack traces already point at readable code; the maps were two thirds of the unpacked size (2.7 MB down to about 0.9 MB).
