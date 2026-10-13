import type { CDPSession, ElementHandle, Frame, JSHandle, Page } from "puppeteer-core";

type ChromeFrame = Frame & {
  _id: string;
  _loaderId: string;
  client: CDPSession;
  mainRealm(): { adoptBackendNode(id: number): Promise<JSHandle<Node>> };
};

/** Identity recorded by the browser snapshot, never a selector supplied by a website. */
export interface SelectedFormControl {
  backendNodeId: number;
  frameId: string;
  loaderId: string;
  tagName: "INPUT" | "TEXTAREA" | "SELECT";
  type: string;
  name: string;
  id: string;
  label: string;
  formBackendNodeId?: number;
}

export interface SelectedFormRequest {
  pageId: string;
  fields: SelectedFormControl[];
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
export type SelectedFormHandles = Map<Frame, ElementHandle<Control>[]>;

export async function disposeSelectedFields(fields: SelectedFormHandles): Promise<void> {
  await Promise.all([...fields.values()].flat().map((handle) => handle.dispose()));
}

/** Rebind a replaced control only within its original, still-attached form and document. */
export async function resolveSelectedFields(
  page: Page,
  selection: SelectedFormRequest,
): Promise<SelectedFormHandles> {
  const result: SelectedFormHandles = new Map();
  try {
    for (const target of selection.fields) {
      const frame = (page.frames() as ChromeFrame[]).find((frame) => frame._id === target.frameId);
      if (!frame || frame._loaderId !== target.loaderId)
        throw new Error("The selected document changed. Take a fresh browser snapshot.");
      const adopt = async (id: number | undefined) =>
        id
          ? frame
              .mainRealm()
              .adoptBackendNode(id)
              .catch(() => null)
          : null;
      const original = await adopt(target.backendNodeId);
      const owner = await adopt(target.formBackendNodeId);
      try {
        const candidates = await frame.evaluateHandle(
          (target, node, owner) => {
            const control = (node: Node | null): node is Control =>
              node instanceof HTMLInputElement ||
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLSelectElement;
            const matches = (input: Control) =>
              input.tagName === target.tagName &&
              input.type === target.type &&
              input.name === target.name &&
              (target.formBackendNodeId ? input.form === owner : input.form === null);
            if (
              target.formBackendNodeId &&
              (!(owner instanceof HTMLFormElement) || !owner.isConnected)
            )
              return [];
            // A connected node with a changed identity is never a fallback candidate.
            if (node?.isConnected)
              return control(node) && node.id === target.id && matches(node) ? [node] : [];
            if (!(owner instanceof HTMLFormElement)) return [];
            const matchesByName = Array.from(owner.elements).filter(
              (input): input is Control =>
                control(input) &&
                matches(input) &&
                (target.name
                  ? input.name === target.name
                  : target.id
                  ? input.id === target.id
                  : !!target.label),
            );
            // Names and IDs must resolve uniquely. Label-only matching uses
            // Chrome's computed accessibility names, with a bounded candidate set.
            if (target.name || target.id) return matchesByName.length === 1 ? matchesByName : [];
            return matchesByName.length <= 100 ? matchesByName : [];
          },
          target,
          original,
          owner,
        );
        const matches: ElementHandle<Control>[] = [];
        let retained: ElementHandle<Control> | undefined;
        let properties = new Map<string, JSHandle>();
        try {
          properties = await candidates.getProperties();
          for (const [key, value] of properties) {
            const input = value.asElement() as ElementHandle<Control> | null;
            if (!/^\d+$/.test(key) || !input) continue;
            const { node } = await frame.client.send("DOM.describeNode", {
              objectId: input.remoteObject().objectId,
            });
            const { nodes } = await frame.client.send("Accessibility.getPartialAXTree", {
              backendNodeId: node.backendNodeId,
              fetchRelatives: false,
            });
            const label = String(nodes.find((node) => !node.ignored)?.name?.value || "")
              .replace(/\s+/g, " ")
              .trim();
            if (label === target.label) matches.push(input);
          }
          if (matches.length === 1) retained = matches[0];
        } finally {
          await candidates.dispose();
          for (const value of properties.values()) if (value !== retained) await value.dispose();
        }
        const handle = retained;
        if (!handle) {
          throw new Error(
            "A selected field changed or its name is ambiguous. Take a fresh browser snapshot.",
          );
        }
        const handles = result.get(frame) || [];
        handles.push(handle);
        result.set(frame, handles);
      } finally {
        await original?.dispose();
        await owner?.dispose();
      }
    }
    return result;
  } catch (error) {
    await disposeSelectedFields(result);
    throw error;
  }
}
