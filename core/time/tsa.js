function tsaInstant(v) {
  return {
    epochSeconds: v.genTimeEpochSeconds,
    tokenDigest: v.tokenDigest,
    authorityId: v.authorityId
  };
}
const isBefore = (a, b) => a.epochSeconds < b.epochSeconds;
const isAfter = (a, b) => a.epochSeconds > b.epochSeconds;
const isStrictlyLater = (later, earlier) => later.epochSeconds > earlier.epochSeconds;
const elapsedSeconds = (from, to) => to.epochSeconds - from.epochSeconds;
function hasElapsed(from, requiredSeconds, observedAt) {
  return elapsedSeconds(from, observedAt) >= BigInt(requiredSeconds);
}
export {
  elapsedSeconds,
  hasElapsed,
  isAfter,
  isBefore,
  isStrictlyLater,
  tsaInstant
};
