import assert from "node:assert/strict";
import { test } from "node:test";
import { readAddress, urlOf } from "./address.ts";

test("the Library is the bare address", () => {
	assert.equal(urlOf({ screen: "library" }), "/");
	assert.deepEqual(readAddress(""), { screen: "library" });
});

test("a Moment playing puts its title in the address, encoded", () => {
	const title = "Interstellar – docking & 50% / no?";
	const url = urlOf({ screen: "library", moment: title });
	assert.equal(
		url,
		"/?moment=Interstellar+%E2%80%93+docking+%26+50%25+%2F+no%3F",
	);
	assert.deepEqual(readAddress(url.slice(1)), {
		screen: "library",
		moment: title,
	});
});

test("the Trimmer shows in the address, with or without a Moment over it", () => {
	assert.equal(urlOf({ screen: "trimmer" }), "/?screen=trimmer");
	assert.deepEqual(readAddress("?screen=trimmer"), { screen: "trimmer" });
	assert.equal(
		urlOf({ screen: "trimmer", moment: "Docking" }),
		"/?screen=trimmer&moment=Docking",
	);
	assert.deepEqual(readAddress("?screen=trimmer&moment=Docking"), {
		screen: "trimmer",
		moment: "Docking",
	});
});

test("an address naming no screen the app has, or an empty title, opens the Library", () => {
	assert.deepEqual(readAddress("?screen=settings"), { screen: "library" });
	assert.deepEqual(readAddress("?moment="), { screen: "library" });
});
