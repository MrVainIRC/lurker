// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A self-hosted instance often outlives the terminal it was launched from
// (`disown`, a dropped SSH session). `disown` only stops the shell's SIGHUP —
// the process still holds fds 1/2 into the pty, and when the pty is torn down
// the NEXT write to stdout/stderr fails with EIO/EPIPE. Without an 'error'
// listener Node surfaces that as an uncaught exception, so the first log line
// after the terminal vanishes kills the server (#442).

/**
 * Swallow exactly the dead-terminal write errors on a stdio stream. Anything
 * else rethrows — a genuine stream failure should still be loud.
 */
export function swallowDeadTtyErrors(stream: NodeJS.EventEmitter): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code !== 'EPIPE' && err?.code !== 'EIO') throw err;
  });
}
