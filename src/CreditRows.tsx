import { useId, useState } from "react";
import {
  availableCreditRoles,
  changeCreditRole,
  resolveCreditPersonId,
  type CreditPerson,
  type CreditRoleOption,
  type CreditRowValue,
} from "./credit-rows";

export function CreditRows<Role extends string>({
  people,
  roles,
  value,
  onChange,
  disabled = false,
}: {
  people: readonly CreditPerson[];
  roles: readonly CreditRoleOption<Role>[];
  value: readonly CreditRowValue<Role>[];
  onChange: (credits: CreditRowValue<Role>[]) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const [pendingPersonName, setPendingPersonName] = useState("");
  const [pendingRole, setPendingRole] = useState<Role | "">(roles[0]?.value ?? "");
  const pendingPersonId = resolveCreditPersonId(pendingPersonName, people);
  const pendingRoles = pendingPersonId
    ? availableCreditRoles(pendingPersonId, roles, value)
    : roles;
  const selectedPendingRole = pendingRoles.some((role) => role.value === pendingRole)
    ? pendingRole
    : pendingRoles[0]?.value ?? "";

  function updatePendingPerson(name: string): void {
    const personId = resolveCreditPersonId(name, people);
    const available = personId ? availableCreditRoles(personId, roles, value) : roles;
    setPendingPersonName(name);
    setPendingRole((current) => available.some((role) => role.value === current)
      ? current
      : available[0]?.value ?? "");
  }

  function addCredit(): void {
    if (!pendingPersonId || !selectedPendingRole || disabled) return;
    onChange([...value, { personId: pendingPersonId, role: selectedPendingRole }]);
    setPendingPersonName("");
    setPendingRole(roles[0]?.value ?? "");
  }

  return (
    <div className="credit-rows">
      <div className="credit-add-row">
        <label className="form-field">
          <span>Person</span>
          <input
            type="search"
            list={listId}
            autoComplete="off"
            placeholder="Search People"
            value={pendingPersonName}
            disabled={disabled}
            onChange={(event) => updatePendingPerson(event.target.value)}
          />
          <datalist id={listId}>
            {people.map((person) => <option value={person.fullName} key={person.id} />)}
          </datalist>
        </label>
        <label className="form-field credit-role-field">
          <span>Role</span>
          <select
            value={selectedPendingRole}
            disabled={disabled || !pendingPersonId || pendingRoles.length === 0}
            onChange={(event) => setPendingRole(event.target.value as Role)}
          >
            {pendingRoles.map((role) => <option value={role.value} key={role.value}>{role.label}</option>)}
          </select>
        </label>
        <button
          className="secondary-action"
          type="button"
          disabled={disabled || !pendingPersonId || !selectedPendingRole}
          onClick={addCredit}
        >
          Add contributor
        </button>
      </div>

      {pendingPersonName && !pendingPersonId && (
        <p className="credit-row-hint">Choose an existing Person from the filtered list.</p>
      )}
      {pendingPersonId && pendingRoles.length === 0 && (
        <p className="credit-row-hint">All available roles for this Person are already added.</p>
      )}

      {value.length === 0 ? (
        <p className="credit-row-empty">No contributors selected.</p>
      ) : (
        <ol className="credit-row-list" aria-label="Selected contributors">
          {value.map((credit, index) => {
            const person = people.find((candidate) => candidate.id === credit.personId);
            const available = availableCreditRoles(credit.personId, roles, value, index);
            return (
              <li key={`${credit.personId}:${credit.role}`}>
                <strong>{person?.fullName ?? "Unavailable Person"}</strong>
                <label className="form-field credit-role-field">
                  <span className="sr-only">Role for {person?.fullName ?? "contributor"}</span>
                  <select
                    aria-label={`Role for ${person?.fullName ?? "contributor"}`}
                    value={credit.role}
                    disabled={disabled}
                    onChange={(event) => onChange(changeCreditRole(
                      value,
                      index,
                      event.target.value as Role,
                    ))}
                  >
                    {available.map((role) => <option value={role.value} key={role.value}>{role.label}</option>)}
                  </select>
                </label>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${person?.fullName ?? "contributor"} · ${roles.find((role) => role.value === credit.role)?.label ?? credit.role}`}
                  onClick={() => onChange(value.filter((_item, creditIndex) => creditIndex !== index))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
