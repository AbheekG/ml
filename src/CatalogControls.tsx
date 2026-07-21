import { useState } from "react";
import {
  activeCatalogFilterCount,
  buildCatalogFilterOptions,
  emptyCatalogFilters,
  type CatalogCreditRole,
  type CatalogFilterOption,
  type CatalogFilters,
  type CatalogSort,
} from "./catalog-view";
import type { CatalogSong } from "./catalog";
import { MAX_CATALOG_SEARCH_QUERY_LENGTH } from "./catalog-search";

const SORT_OPTIONS: Array<{ value: CatalogSort; label: string }> = [
  { value: "latin-asc", label: "Latin title A–Z" },
  { value: "latin-desc", label: "Latin title Z–A" },
  { value: "native-asc", label: "Native title A–Z" },
  { value: "native-desc", label: "Native title Z–A" },
  { value: "updated-desc", label: "Recently updated" },
  { value: "created-desc", label: "Recently created" },
];

const ROLE_OPTIONS: Array<{ value: CatalogCreditRole; label: string }> = [
  { value: "any", label: "Any role" },
  { value: "lyrics", label: "Lyrics" },
  { value: "music", label: "Music" },
  { value: "vocals", label: "Vocals" },
];

type MultiFilterKey = "languageIds" | "tagIds" | "notebookIds" | "statuses";

function optionName(options: CatalogFilterOption[], id: string): string {
  return options.find((option) => option.id === id)?.name ?? id;
}

function roleName(role: CatalogCreditRole): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

function SelectedValues({
  selected,
  options,
  label,
  onRemove,
}: {
  selected: string[];
  options: CatalogFilterOption[];
  label: string;
  onRemove: (value: string) => void;
}) {
  if (selected.length === 0) return null;
  return (
    <div className="catalog-field-selections" aria-label={`Selected ${label} filters`}>
      {selected.map((id) => (
        <button key={id} type="button" onClick={() => onRemove(id)} aria-label={`Remove ${optionName(options, id)} ${label} filter`}>
          {optionName(options, id)}<span aria-hidden="true">×</span>
        </button>
      ))}
    </div>
  );
}

function AddFilterSelect({
  label,
  placeholder,
  options,
  selected,
  disabled,
  onAdd,
  onRemove,
}: {
  label: string;
  placeholder: string;
  options: CatalogFilterOption[];
  selected: string[];
  disabled: boolean;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const remaining = options.filter((option) => !selected.includes(option.id));
  return (
    <div className="catalog-filter-group">
      <label className="catalog-filter-field">
        <span>{label}</span>
        <select
          value=""
          disabled={disabled || remaining.length === 0}
          onChange={(event) => onAdd(event.target.value)}
        >
          <option value="">{remaining.length === 0 && selected.length > 0 ? "All selected" : placeholder}</option>
          {remaining.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
      <SelectedValues selected={selected} options={options} label={label} onRemove={onRemove} />
    </div>
  );
}

export function CatalogControls({
  songs,
  query,
  filters,
  sort,
  onQueryChange,
  onFiltersChange,
  onSortChange,
}: {
  songs: CatalogSong[];
  query: string;
  filters: CatalogFilters;
  sort: CatalogSort;
  onQueryChange: (query: string) => void;
  onFiltersChange: (filters: CatalogFilters) => void;
  onSortChange: (sort: CatalogSort) => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pendingPersonId, setPendingPersonId] = useState("");
  const [pendingPersonRole, setPendingPersonRole] = useState<CatalogCreditRole>("any");
  const options = buildCatalogFilterOptions(songs);
  const activeCount = activeCatalogFilterCount(filters);
  const disabled = songs.length === 0;
  const pendingRoleOptions = ROLE_OPTIONS.filter((roleOption) => (
    roleOption.value === "any"
    || songs.some((song) => song.credits.some((credit) => (
      credit.personId === pendingPersonId && credit.role === roleOption.value
    )))
  ));

  const addFilter = (key: MultiFilterKey, value: string) => {
    if (!value || filters[key].includes(value)) return;
    onFiltersChange({ ...filters, [key]: [...filters[key], value] });
  };

  const removeFilter = (key: MultiFilterKey, value: string) => {
    const values = filters[key].filter((selected) => selected !== value);
    onFiltersChange({ ...filters, [key]: values });
  };

  const pendingPersonExists = filters.people.some((personFilter) => (
    personFilter.personId === pendingPersonId && personFilter.role === pendingPersonRole
  ));

  const addPersonFilter = () => {
    if (!pendingPersonId || pendingPersonExists) return;
    onFiltersChange({
      ...filters,
      people: [...filters.people, { personId: pendingPersonId, role: pendingPersonRole }],
    });
    setPendingPersonId("");
    setPendingPersonRole("any");
  };

  const removePersonFilter = (personId: string, role: CatalogCreditRole) => {
    onFiltersChange({
      ...filters,
      people: filters.people.filter((personFilter) => (
        personFilter.personId !== personId || personFilter.role !== role
      )),
    });
  };

  const clearFilters = () => {
    onFiltersChange(emptyCatalogFilters());
    setPendingPersonId("");
    setPendingPersonRole("any");
  };

  const chips: Array<{ key: string; label: string; remove: () => void }> = [
    ...filters.languageIds.map((id) => ({
      key: `language:${id}`,
      label: `Language: ${optionName(options.languages, id)}`,
      remove: () => removeFilter("languageIds", id),
    })),
    ...filters.tagIds.map((id) => ({
      key: `tag:${id}`,
      label: `Tag: ${optionName(options.tags, id)}`,
      remove: () => removeFilter("tagIds", id),
    })),
    ...filters.people.map((personFilter) => ({
      key: `person:${personFilter.personId}:${personFilter.role}`,
      label: `Person: ${optionName(options.people, personFilter.personId)} · ${roleName(personFilter.role)}`,
      remove: () => removePersonFilter(personFilter.personId, personFilter.role),
    })),
    ...filters.notebookIds.map((id) => ({
      key: `notebook:${id}`,
      label: `Notebook: ${optionName(options.notebooks, id)}`,
      remove: () => removeFilter("notebookIds", id),
    })),
    ...filters.statuses.map((id) => ({
      key: `status:${id}`,
      label: `Status: ${optionName(options.statuses, id)}`,
      remove: () => removeFilter("statuses", id),
    })),
    ...(filters.hasLyrics ? [{
      key: "has-lyrics",
      label: "Has typed lyrics",
      remove: () => onFiltersChange({ ...filters, hasLyrics: false }),
    }] : []),
    ...(filters.hasScans ? [{
      key: "has-scans",
      label: "Has Scans",
      remove: () => onFiltersChange({ ...filters, hasScans: false }),
    }] : []),
    ...(filters.hasRecordings ? [{
      key: "has-recordings",
      label: "Has Recordings",
      remove: () => onFiltersChange({ ...filters, hasRecordings: false }),
    }] : []),
  ];

  return (
    <>
      <section className="catalog-tools" aria-label="Catalog tools">
        <label className="search-field">
          <span className="sr-only">Search songs</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            maxLength={MAX_CATALOG_SEARCH_QUERY_LENGTH}
            placeholder="Search titles, lyrics, and metadata"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            disabled={disabled}
          />
        </label>
        <label className="catalog-sort-field">
          <span>{query.trim() ? "Then sort" : "Sort"}</span>
          <select
            value={sort}
            disabled={disabled}
            onChange={(event) => onSortChange(event.target.value as CatalogSort)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          className="secondary-action filter-toggle"
          type="button"
          disabled={disabled}
          aria-expanded={filtersOpen}
          aria-controls="catalog-filter-panel"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Filters{activeCount > 0 ? ` (${activeCount})` : ""}
        </button>
      </section>

      {!filtersOpen && chips.length > 0 && (
        <div className="catalog-filter-chips" aria-label="Selected filters">
          {chips.map((chip) => (
            <button key={chip.key} type="button" onClick={chip.remove} aria-label={`Remove ${chip.label} filter`}>
              {chip.label}<span aria-hidden="true">×</span>
            </button>
          ))}
          <button className="clear-filter-chip" type="button" onClick={clearFilters}>Clear all</button>
        </div>
      )}

      {filtersOpen && (
        <section className="catalog-filter-panel" id="catalog-filter-panel" aria-labelledby="catalog-filter-title">
          <div className="catalog-filter-heading">
            <div>
              <p className="eyebrow">Catalog filters</p>
              <h2 id="catalog-filter-title">Narrow the list</h2>
            </div>
            <button
              className="text-action"
              type="button"
              disabled={activeCount === 0}
              onClick={clearFilters}
            >
              Clear all
            </button>
          </div>
          <div className="catalog-filter-grid">
            <AddFilterSelect
              label="Language"
              placeholder="Any language"
              options={options.languages}
              selected={filters.languageIds}
              disabled={disabled}
              onAdd={(value) => addFilter("languageIds", value)}
              onRemove={(value) => removeFilter("languageIds", value)}
            />
            <AddFilterSelect
              label="Tag"
              placeholder="Any tag"
              options={options.tags}
              selected={filters.tagIds}
              disabled={disabled}
              onAdd={(value) => addFilter("tagIds", value)}
              onRemove={(value) => removeFilter("tagIds", value)}
            />
            <div className="catalog-filter-group person-role-filter">
              <span className="catalog-filter-group-label">Person and role</span>
              <div className="person-role-inputs">
                <label className="catalog-filter-field">
                  <span>Person</span>
                  <select
                    value={pendingPersonId}
                    disabled={disabled}
                    onChange={(event) => {
                      setPendingPersonId(event.target.value);
                      setPendingPersonRole("any");
                    }}
                  >
                    <option value="">Choose a person</option>
                    {options.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                </label>
                <label className="catalog-filter-field">
                  <span>Role</span>
                  <select
                    value={pendingPersonRole}
                    disabled={!pendingPersonId}
                    onChange={(event) => setPendingPersonRole(event.target.value as CatalogCreditRole)}
                  >
                    {pendingRoleOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  className="secondary-action add-person-filter"
                  type="button"
                  disabled={!pendingPersonId || pendingPersonExists}
                  onClick={addPersonFilter}
                >
                  Add
                </button>
              </div>
              {filters.people.length > 0 && (
                <div className="catalog-field-selections" aria-label="Selected Person and role filters">
                  {filters.people.map((personFilter) => {
                    const label = `${optionName(options.people, personFilter.personId)} · ${roleName(personFilter.role)}`;
                    return (
                      <button
                        key={`${personFilter.personId}:${personFilter.role}`}
                        type="button"
                        onClick={() => removePersonFilter(personFilter.personId, personFilter.role)}
                        aria-label={`Remove ${label} Person and role filter`}
                      >
                        {label}<span aria-hidden="true">×</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <AddFilterSelect
              label="Notebook"
              placeholder="Any notebook"
              options={options.notebooks}
              selected={filters.notebookIds}
              disabled={disabled}
              onAdd={(value) => addFilter("notebookIds", value)}
              onRemove={(value) => removeFilter("notebookIds", value)}
            />
            <AddFilterSelect
              label="Status"
              placeholder="Any status"
              options={options.statuses}
              selected={filters.statuses}
              disabled={disabled}
              onAdd={(value) => addFilter("statuses", value)}
              onRemove={(value) => removeFilter("statuses", value)}
            />
          </div>
          <fieldset className="catalog-presence-filters">
            <legend>Must include</legend>
            <label><input type="checkbox" checked={filters.hasLyrics} onChange={(event) => onFiltersChange({ ...filters, hasLyrics: event.target.checked })} /> Typed lyrics</label>
            <label><input type="checkbox" checked={filters.hasScans} onChange={(event) => onFiltersChange({ ...filters, hasScans: event.target.checked })} /> Scans</label>
            <label><input type="checkbox" checked={filters.hasRecordings} onChange={(event) => onFiltersChange({ ...filters, hasRecordings: event.target.checked })} /> Recordings</label>
          </fieldset>
        </section>
      )}
    </>
  );
}
