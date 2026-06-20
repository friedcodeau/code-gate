// A small utility module with several deliberately-planted issues for testing
// the AI Quality Gate's semantic (LLM) layer.
//
// None of these are catchable by the local regex/AST checks — there are no
// hardcoded secrets and no repeated lines — so any finding the gate reports on
// this file must have come from the LLM. That makes it a clean end-to-end test.

export function deduplicate(items: number[]): number[] {
  // Hallucinated API: Array.prototype.removeDuplicates() does not exist.
  return (items as any).removeDuplicates();
}

export function sumRange(values: number[]): number {
  let total = 0;
  // Off-by-one: i <= length reads undefined on the final iteration.
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total;
}

export function isAdult(age: number): boolean {
  // Inverted condition: returns true for minors.
  return age < 18;
}

export async function loadConfig(url: string): Promise<unknown> {
  const res = await fetch(url);
  // No status check: assumes success and parses the body regardless.
  return res.json();
}
