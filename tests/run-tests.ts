import {
  testCliModuleCanBeImported,
  testServerModuleCanBeImported,
} from './entrypoints.test';
import {
  testScoringPenalizesMissingContactPath,
  testScoringPhoneDependentLead,
} from './scoring.test';

const tests: Array<[string, () => void | Promise<void>]> = [
  ['CLI module can be imported', testCliModuleCanBeImported],
  ['server module can be imported', testServerModuleCanBeImported],
  ['scores phone-dependent trade lead as A priority', testScoringPhoneDependentLead],
  ['penalizes leads without any contact path', testScoringPenalizesMissingContactPath],
];

let failures = 0;

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
