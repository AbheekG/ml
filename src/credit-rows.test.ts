import { describe, expect, it } from "vitest";
import {
  availableCreditRoles,
  changeCreditRole,
  resolveCreditPersonId,
} from "./credit-rows";

const people = [
  { id: "person-1", fullName: "Person One" },
  { id: "person-2", fullName: "Person Two" },
];
const roles = [
  { value: "lyrics" as const, label: "Lyrics" },
  { value: "music" as const, label: "Music" },
];

describe("compact credit rows", () => {
  it("resolves only an exact normalized Person selection", () => {
    expect(resolveCreditPersonId("  PERSON   one ", people)).toBe("person-1");
    expect(resolveCreditPersonId("Person", people)).toBeNull();
    expect(resolveCreditPersonId("", people)).toBeNull();
  });

  it("offers only Person/Role combinations not already selected", () => {
    const credits = [{ personId: "person-1", role: "lyrics" as const }];
    expect(availableCreditRoles("person-1", roles, credits)).toEqual([
      { value: "music", label: "Music" },
    ]);
    expect(availableCreditRoles("person-2", roles, credits)).toEqual(roles);
  });

  it("keeps a row's current role available while editing it", () => {
    const credits = [
      { personId: "person-1", role: "lyrics" as const },
      { personId: "person-1", role: "music" as const },
    ];
    expect(availableCreditRoles("person-1", roles, credits, 0)).toEqual([
      { value: "lyrics", label: "Lyrics" },
    ]);
  });

  it("rejects a role change that would duplicate a Person/Role pair", () => {
    const credits = [
      { personId: "person-1", role: "lyrics" as const },
      { personId: "person-1", role: "music" as const },
    ];
    expect(changeCreditRole(credits, 0, "music")).toEqual(credits);
    expect(changeCreditRole(credits, 0, "lyrics")).toEqual(credits);
  });
});
