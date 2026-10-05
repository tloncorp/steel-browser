// Only metadata crosses the public discovery boundary. Values stay in a POST body.
export function projectFields(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 40)
    return null;
  const ids = new Set();
  const projected = [];
  for (const field of fields) {
    if (
      !field ||
      typeof field !== "object" ||
      typeof field.id !== "string" ||
      !/^f\d{1,2}$/.test(field.id) ||
      ids.has(field.id) ||
      typeof field.purpose !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(field.purpose) ||
      typeof field.label !== "string" ||
      !field.label.length ||
      field.label.length > 256 ||
      ![
        "text",
        "password",
        "numeric",
        "email",
        "tel",
        "textarea",
        "select",
      ].includes(field.inputType) ||
      typeof field.required !== "boolean" ||
      (field.maxLength !== undefined &&
        (!Number.isSafeInteger(field.maxLength) ||
          field.maxLength < 1 ||
          field.maxLength > 4096)) ||
      (field.exactLength !== undefined &&
        (!Number.isSafeInteger(field.exactLength) ||
          field.exactLength < 1 ||
          field.exactLength > 12))
    )
      return null;
    ids.add(field.id);
    let options;
    if (field.inputType === "select") {
      if (
        !Array.isArray(field.options) ||
        !field.options.length ||
        field.options.length > 512
      )
        return null;
      const choices = new Set();
      options = [];
      for (const option of field.options) {
        if (
          !option ||
          typeof option.value !== "string" ||
          !/^\d{1,4}$/.test(option.value) ||
          choices.has(option.value) ||
          typeof option.label !== "string" ||
          option.label.length > 256
        )
          return null;
        choices.add(option.value);
        options.push({ value: option.value, label: option.label });
      }
    }
    projected.push({
      id: field.id,
      purpose: field.purpose,
      label: field.label,
      inputType: field.inputType,
      required: field.required,
      ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      ...(field.exactLength === undefined
        ? {}
        : { exactLength: field.exactLength }),
      ...(options ? { options } : {}),
    });
  }
  return projected;
}

export function validValues(fields, values) {
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).some(
      (id) => !fields.some((field) => field.id === id),
    ) ||
    !Object.values(values).some(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    return false;
  return fields.every((field) => {
    const value = values[field.id];
    if (value === undefined || value === "") return !field.required;
    return (
      typeof value === "string" &&
      value.length <= (field.maxLength ?? 4096) &&
      (field.exactLength === undefined || value.length === field.exactLength) &&
      (!field.options || field.options.some((option) => option.value === value))
    );
  });
}
