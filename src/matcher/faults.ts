/** Test-only fault injection. Ignored unless a test assigns a hook. */
export const testFaults: {
  beforeCommit: null | (() => void);
  pauseClaim: boolean;
} = {
  beforeCommit: null,
  pauseClaim: false,
};
