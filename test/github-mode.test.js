import test from "node:test";
import assert from "node:assert/strict";
import { classifyGithubModeChange, isRelevantModuleFile } from "../src/github-monitor.js";

test("detects launchpad contract and deployment files", () => {
  assert.equal(isRelevantModuleFile("contracts/src/FactoryV2.sol"), true);
  assert.equal(isRelevantModuleFile("docs/logo.png"), false);
});

test("classifies a newly added contract module as a new mode candidate", () => {
  const result = classifyGithubModeChange("add graduation mode", [{ filename: "contracts/src/CurveV2.sol", status: "added" }]);
  assert.equal(result.candidate, true);
  assert.equal(result.reason, "new_contract_or_module_file");
});

test("classifies only explicit new GitHub modes and ignores maintenance wording", () => {
  const modifiedVault = [{ filename: "contracts/src/VaultV2.sol", status: "modified" }];
  assert.equal(classifyGithubModeChange("feat: add Vault V2", modifiedVault).candidate, true);
  assert.equal(classifyGithubModeChange("introduce a new Crowd Launch strategy", modifiedVault).candidate, true);
  for (const message of [
    "fix: Vault V2",
    "revert feat: add Vault V2",
    "test: Vault V2",
    "docs: explain Vault V2",
    "refactor Vault V2",
    "add tests for Vault V2",
    "update Vault V2",
  ]) assert.equal(classifyGithubModeChange(message, modifiedVault).candidate, false, message);
});

test("a production module or deployment file remains actionable despite maintenance wording", () => {
  assert.equal(classifyGithubModeChange("fix: Vault V2", [
    { filename: "contracts/src/VaultV2.sol", status: "added" },
  ]).candidate, true);
  assert.equal(classifyGithubModeChange("test: Vault V2", [
    { filename: "test/VaultV2.t.sol", status: "added" },
  ]).candidate, false);
});
