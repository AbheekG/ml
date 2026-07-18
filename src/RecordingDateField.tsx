import { recordingDateInputDetails } from "./local-date";

export function RecordingDateField({
  value,
  onChange,
  disabled = false,
  errors = [],
  currentTime,
  deviceTimeZone,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  errors?: string[];
  currentTime?: Date;
  deviceTimeZone?: string;
}) {
  const { maximumDate, indiaDateNote } = recordingDateInputDetails(
    currentTime,
    deviceTimeZone,
  );
  return (
    <label className="form-field compact-field">
      <span>Recorded date</span>
      <input
        disabled={disabled}
        type="date"
        max={maximumDate}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {indiaDateNote && <small>{indiaDateNote}</small>}
      {errors.map((message) => <em key={message}>{message}</em>)}
    </label>
  );
}
