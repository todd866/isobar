// Verify workflow routing without scheduling hosted jobs or running native tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const condition = "github.repository == 'todd866/isobar' || github.event_name == 'workflow_dispatch'";
for (const [file, expectedJobs] of [['native.yml', ['build', 'sanitize']], ['python.yml', ['test']]]) {
  const yaml = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
  const jobs = [...yaml.split('jobs:\n')[1].matchAll(/^  ([a-z-]+):\n([\s\S]*?)(?=^  [a-z-]+:|$(?![\s\S]))/gm)];
  test(`${file}: every hosted job excludes private automatic events`, () => {
    assert.deepEqual(jobs.map(job => job[1]), expectedJobs);
    for (const [, name, body] of jobs) {
      const actual = body.match(/^    if: (.+)$/m)?.[1];
      assert.equal(actual, condition, name);
      const allows = new Function('github', `return (${actual});`);
      for (const event of ['push', 'pull_request']) {
        assert.equal(allows({repository:'todd866/isobar-private', event_name:event}), false);
        assert.equal(allows({repository:'todd866/isobar', event_name:event}), true);
      }
      assert.equal(allows({repository:'todd866/isobar-private', event_name:'workflow_dispatch'}), true);
    }
    assert.match(yaml, /^  workflow_dispatch:/m);
    assert.match(yaml, /^  push:\n    branches: \[main\]/m);
    assert.match(yaml, /^  pull_request:/m);
  });
  test(`${file}: complete manual/public assertions remain present`, () => {
    if (file === 'native.yml') {
      assert.ok(yaml.includes('ISOBAR_ADHOC=1 ISOBAR_BUNDLE_COLLECTOR=0 ISOBAR_CI_SLOW=1 ./build.sh'));
      assert.ok(yaml.includes('Check version and help'));
      assert.ok(yaml.includes('Check executable deployment target'));
      assert.ok(yaml.includes('run: ./tools/sanitize.sh'));
    } else {
      assert.ok(yaml.includes("python3 tools/run-python-tests.py Tests 'test_*.py'"));
      assert.ok(yaml.includes('python3 -m pytest wall -q --timeout=90 --timeout-method=signal'));
      assert.ok(yaml.includes('pytest pytest-timeout pillow'));
    }
  });
}
