// Display-only version classification. Never grants trade authority or rewrites
// stored batch reports; missing frozen evidence remains unknown.
const version = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
  && !['legacy_unversioned', 'legacy_unknown'].includes(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function classifyStrategyCohort(cohort, snapshot = {}) {
  const requirements = snapshot.strategyValidationRequirements, missing = [], mismatched = [];
  if (!requirements || !version(requirements.entryFlowVersion) || !version(requirements.exitObservationVersion))
    return { status: 'unknown', reasons: ['current_validation_requirements_missing'] };
  const same = (field, expected, evidenceField = null) => {
    const evidence = evidenceField ? cohort?.[evidenceField] : 'recorded';
    const actual = cohort?.[field], mixed = evidence === 'mixed' && typeof actual === 'string' && actual.split('+').length > 1
      && actual.split('+').every(version) && new Set(actual.split('+')).size === actual.split('+').length;
    if ((!version(actual) && !mixed) || !['recorded', 'mixed'].includes(evidence)) missing.push(field);
    else if (cohort[field] !== expected) mismatched.push(field);
  };
  same('reasoningVersion', 'evidence_first_v1');
  same('entryFlowVersion', requirements.entryFlowVersion, 'entryFlowVersionEvidence');
  same('exitObservationVersion', requirements.exitObservationVersion, 'exitObservationVersionEvidence');
  if (requirements.exitStructureObservationVersion != null) {
    if (!version(requirements.exitStructureObservationVersion)) missing.push('current_exit_structure_requirement');
    else same('exitStructureObservationVersion', requirements.exitStructureObservationVersion, 'exitStructureObservationVersionEvidence');
  }
  const entryStructures = requirements.entryStructureBySetup;
  if (entryStructures && Object.hasOwn(entryStructures, cohort?.setupId)) {
    if (!version(entryStructures[cohort.setupId])) missing.push('current_entry_structure_requirement');
    else same('entryStructureVersion', entryStructures[cohort.setupId]);
  }
  if (!version(snapshot.mainExitPolicy?.version)) missing.push('current_exit_policy');
  else same('exitVersion', snapshot.mainExitPolicy.version, 'exitVersionEvidence');
  if (['multi_setup_v1', 'multi_setup_v2'].includes(snapshot.opportunityMode)) same('opportunityVersion', snapshot.opportunityMode);
  if (snapshot.operatingPolicy?.continuous === true) same('accountPolicyVersion', 'continuous_paper_v1');
  const targets = requirements.targetSelectionBySetup;
  if (cohort?.setupId === 'external_pullback' || targets && Object.hasOwn(targets, cohort?.setupId)) {
    const targetVersion = targets?.[cohort?.setupId];
    if (!version(targetVersion)) missing.push('current_target_selection_requirement');
    else same('targetSelectionVersion', targetVersion);
  }
  for (const field of ['entryCostVersion', 'exitCostVersion']) {
    if (version(requirements[field])) same(field, requirements[field], field === 'exitCostVersion' ? 'exitCostVersionEvidence' : null);
    else if (!version(cohort?.[field]) || field === 'exitCostVersion' && cohort?.exitCostVersionEvidence !== 'recorded') missing.push(field);
  }
  return { status: missing.length ? 'unknown' : mismatched.length ? 'legacy' : 'current', reasons: [...missing, ...mismatched] };
}

export function strategyCohortSummary(cohorts = [], snapshot = {}) {
  const result = { current: [], legacy: [], unknown: [], currentRounds: 0, legacyRounds: 0, unknownRounds: 0 };
  for (const cohort of Array.isArray(cohorts) ? cohorts : []) {
    const { status } = classifyStrategyCohort(cohort, snapshot);
    result[status].push(cohort); result[`${status}Rounds`] += count(cohort?.closedRounds);
  }
  return result;
}
