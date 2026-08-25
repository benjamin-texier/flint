#!/usr/bin/env bash

set +e

cd frontend && pnpm build && cd ..
cargo run 
