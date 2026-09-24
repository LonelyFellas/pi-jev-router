/**
 * Local credential-source tests (no network).
 * Run: npx tsx src/credentials.test.ts
 */
import assert from "node:assert/strict";
import {
	CredentialResolutionError,
	describeCredentialSource,
	redactCredential,
	resolveCredential,
} from "./credentials.ts";

// Explicit literal config wins over the legacy fallback environment value.
{
	const value = await resolveCredential({
		provider: "Jev",
		configuredValue: "literal-value",
		environmentValue: "fallback-value",
	});
	assert.equal(value, "literal-value");
}

// $ENV and ${ENV} read from the supplied environment.
{
	const value = await resolveCredential({
		provider: "Jev",
		configuredValue: "$TEST_CREDENTIAL",
		environment: { TEST_CREDENTIAL: "env-value" },
	});
	assert.equal(value, "env-value");

	const braced = await resolveCredential({
		provider: "Jev",
		configuredValue: "${TEST_CREDENTIAL}",
		environment: { TEST_CREDENTIAL: "env-value" },
	});
	assert.equal(braced, "env-value");
}

// Malformed explicit sources fail closed.
{
	await assert.rejects(
		resolveCredential({ provider: "Jev", configuredValue: "$not closed", environment: {} }),
		(error: unknown) =>
			error instanceof CredentialResolutionError && error.category === "invalid-source",
	);
}

// Command sources are resolved through the injected runner and trimmed.
{
	const value = await resolveCredential({
		provider: "Jev",
		configuredValue: "!/usr/bin/security find-generic-password -s pi-jev-router -a typesafe -w",
		runCommand: async () => ({ stdout: "command-value\n" }),
	});
	assert.equal(value, "command-value");
}

// Empty command output is a credential failure, not a silent fallback.
{
	await assert.rejects(
		resolveCredential({
			provider: "Jev",
			configuredValue: "!command",
			runCommand: async () => ({ stdout: "\n" }),
		}),
		(error: unknown) =>
			error instanceof CredentialResolutionError && error.category === "command-empty",
	);
}

// Status descriptions never include secret values.
{
	assert.equal(
		describeCredentialSource({
			configuredValue: "$TEST_CREDENTIAL",
			environmentName: "TYPESAFE_API_KEY",
			environment: { TEST_CREDENTIAL: "env-value" },
		}),
		"present (env TEST_CREDENTIAL)",
	);
	assert.equal(
		describeCredentialSource({ environmentName: "TYPESAFE_API_KEY", environment: {} }),
		"missing (env TYPESAFE_API_KEY)",
	);
}

assert.equal(redactCredential("token=secret-value", "secret-value"), "token=[redacted]");

console.log("credentials.test: all assertions passed");
