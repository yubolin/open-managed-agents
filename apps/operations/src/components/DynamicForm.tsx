import { useState, type FormEvent } from "react";
import { validateRequiredFields } from "../lib/utils";

interface DynamicFormProps {
  formSchema: Record<string, any> | null;
  uiSchema?: Record<string, any> | null;
  initialValues?: Record<string, any>;
  onSubmit: (values: Record<string, any>) => void;
  onCancel?: () => void;
  isSubmitting?: boolean;
  submitLabel?: string;
}

export function DynamicForm({
  formSchema,
  uiSchema,
  initialValues = {},
  onSubmit,
  onCancel,
  isSubmitting = false,
  submitLabel = "确认提交",
}: DynamicFormProps) {
  const [formData, setFormData] = useState<Record<string, any>>(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!formSchema || !formSchema.properties) {
    return (
      <div className="p-4 text-sm text-slate-400 bg-slate-900/50 rounded-lg border border-slate-800">
        该服务模板无需填写额外参数。
      </div>
    );
  }

  const properties = formSchema.properties as Record<string, any>;
  const requiredFields = (formSchema.required as string[]) || [];

  const handleChange = (field: string, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const newErrors = validateRequiredFields(requiredFields, formData);

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {Object.entries(properties).map(([field, schema]) => {
        const isRequired = requiredFields.includes(field);
        const title = schema.title || field;
        const desc = schema.description;
        const uiWidget = uiSchema?.[field]?.["ui:widget"];
        const enumValues = schema.enum as string[] | undefined;

        return (
          <div key={field} className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-300">
              {title}
              {isRequired && <span className="text-rose-400 ml-1">*</span>}
            </label>
            {desc && <p className="text-[11px] text-slate-500">{desc}</p>}

            {enumValues ? (
              <select
                value={formData[field] || ""}
                onChange={(e) => handleChange(field, e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              >
                <option value="">请选择...</option>
                {enumValues.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : schema.type === "boolean" ? (
              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={!!formData[field]}
                  onChange={(e) => handleChange(field, e.target.checked)}
                  className="rounded border-slate-700 text-emerald-500 focus:ring-0 bg-slate-900"
                />
                <span className="text-xs text-slate-300">启用 / 是</span>
              </label>
            ) : uiWidget === "textarea" || schema.type === "object" ? (
              <textarea
                rows={3}
                value={typeof formData[field] === "object" ? JSON.stringify(formData[field], null, 2) : formData[field] || ""}
                onChange={(e) => handleChange(field, e.target.value)}
                placeholder={schema.default ? `默认: ${schema.default}` : ""}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-emerald-500"
              />
            ) : schema.type === "number" || schema.type === "integer" ? (
              <input
                type="number"
                value={formData[field] ?? ""}
                onChange={(e) => handleChange(field, Number(e.target.value))}
                placeholder={schema.default ? `默认: ${schema.default}` : ""}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            ) : (
              <input
                type="text"
                value={formData[field] || ""}
                onChange={(e) => handleChange(field, e.target.value)}
                placeholder={schema.default ? `默认: ${schema.default}` : ""}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            )}

            {errors[field] && <p className="text-[11px] text-rose-400">{errors[field]}</p>}
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-900 hover:bg-slate-800 rounded-lg border border-slate-700 transition-colors"
          >
            取消
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 rounded-lg shadow-sm glow-emerald transition-all disabled:opacity-50"
        >
          {isSubmitting ? "提交中..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
