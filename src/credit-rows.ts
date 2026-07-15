export type CreditPerson = { id: string; fullName: string };
export type CreditRoleOption<Role extends string> = { value: Role; label: string };
export type CreditRowValue<Role extends string> = { personId: string; role: Role };

function normalizedPersonName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function resolveCreditPersonId(
  value: string,
  people: readonly CreditPerson[],
): string | null {
  const normalized = normalizedPersonName(value);
  if (!normalized) return null;
  return people.find((person) => normalizedPersonName(person.fullName) === normalized)?.id ?? null;
}

export function availableCreditRoles<Role extends string>(
  personId: string,
  roles: readonly CreditRoleOption<Role>[],
  credits: readonly CreditRowValue<Role>[],
  excludedIndex: number | null = null,
): CreditRoleOption<Role>[] {
  return roles.filter((role) => !credits.some((credit, index) => (
    index !== excludedIndex
    && credit.personId === personId
    && credit.role === role.value
  )));
}

export function changeCreditRole<Role extends string>(
  credits: readonly CreditRowValue<Role>[],
  index: number,
  role: Role,
): CreditRowValue<Role>[] {
  if (index < 0 || index >= credits.length) return [...credits];
  const current = credits[index];
  if (credits.some((credit, creditIndex) => (
    creditIndex !== index
    && credit.personId === current.personId
    && credit.role === role
  ))) return [...credits];
  return credits.map((credit, creditIndex) => creditIndex === index
    ? { ...credit, role }
    : credit);
}
