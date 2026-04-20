import {
  onDestroyRobustnessScenario,
  onInitFailsScenario,
  pluginFailsScenario,
  type ScenarioResult,
} from './scenarios.js';

function logResult(title: string, result: ScenarioResult): void {
  console.log(`\n=== ${title} ===`);
  console.log(`  start rejected : ${result.startRejected}`);
  if (result.startError) console.log(`  start error    : ${result.startError}`);
  console.log(`  stop rejected  : ${result.stopRejected}`);
  if (result.stopError) console.log(`  stop error     : ${result.stopError}`);
  console.log(`  initialized    : [${result.initializedServices.join(', ')}]`);
  console.log(`  destroyed      : [${result.destroyedServices.join(', ')}]`);
}

async function main(): Promise<void> {
  console.log('moribashi error-handling example — running scenarios sequentially');

  logResult('Scenario A — async plugin throws from register()', await pluginFailsScenario());
  logResult('Scenario B — service onInit() throws', await onInitFailsScenario());
  logResult(
    'Scenario C — one onDestroy() throws during stop()',
    await onDestroyRobustnessScenario(),
  );

  console.log('\nNote: see README.md for what each scenario demonstrates about moribashi today.');
}

await main();
