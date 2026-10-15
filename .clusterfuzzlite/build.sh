#!/bin/bash -eu
# Builds the fuzz targets in fuzz/ with the OSS-Fuzz images, for ClusterFuzzLite
# or OSS-Fuzz tooling (sanitizer "none"). Jazzer.js comes from package-lock.json,
# the same pinned version npm run fuzz:* and the Fuzzing workflow use.

npm ci --ignore-scripts --no-audit --no-fund
# npm can exit 0 after an internal error; make sure Jazzer.js is really there.
test -f node_modules/@jazzer.js/core/dist/cli.js

compile_javascript_fuzzer byoghapp fuzz/fuzz_yaml.js --sync
compile_javascript_fuzzer byoghapp fuzz/fuzz_render.js --sync

# Seed corpora: every entry and data file.
zip -q -j "$OUT/fuzz_yaml_seed_corpus.zip" entries/*.yaml data/*.yaml
zip -q -j "$OUT/fuzz_render_seed_corpus.zip" entries/*.yaml
