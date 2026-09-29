// The take's clock (SECRETS-DESIGN T1): the wall clock, the one screencast frames carry, so reads,
// events and frames agree through a take (a sleeping machine included). A wall-clock step during a
// take is a stated gap (§6): a read then looks older and only adds coverage.
export const now = (): number => Date.now()
