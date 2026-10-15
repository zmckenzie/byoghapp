// A node:test reporter that prints one JSON line per test case:
// {"path": "suite name test name", "ms": 12.3, "passed": true}
// `path` is the case's full name as --test-name-pattern matches it (ancestor
// names and its own name joined by spaces). Mutation testing uses it to
// profile and run single test cases.

/** Turns node:test reporter events into JSON lines for leaf test cases. */
export default async function* testListReporter(source) {
  const stack = [];
  for await (const event of source) {
    const { type, data } = event;
    if (type === 'test:start') {
      stack.length = data.nesting;
      stack.push(data.name);
    } else if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') {
      const path = [...stack.slice(0, data.nesting), data.name].join(' ');
      yield `${JSON.stringify({ path, ms: data.details?.duration_ms ?? 0, passed: type === 'test:pass' })}\n`;
    }
  }
}
