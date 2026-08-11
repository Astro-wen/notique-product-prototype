export type SimpleImportProject = { id: string };
export type SimpleImportEvent = { id: string };

export type SimpleImportTarget<Project extends SimpleImportProject, Event extends SimpleImportEvent> = {
  project: Project;
  event: Event;
  createdProject: boolean;
  createdEvent: boolean;
};

export async function resolveSimpleImportTarget<
  Project extends SimpleImportProject,
  Event extends SimpleImportEvent,
>(input: {
  project: Project | null;
  event: Event | null;
  createTest: () => Promise<{ project: Project; event: Event } | null>;
  createEvent: (project: Project) => Promise<Event>;
}): Promise<SimpleImportTarget<Project, Event> | null> {
  if (!input.project) {
    const created = await input.createTest();
    if (!created) return null;
    return {
      ...created,
      createdProject: true,
      createdEvent: true,
    };
  }
  if (input.event) {
    return {
      project: input.project,
      event: input.event,
      createdProject: false,
      createdEvent: false,
    };
  }
  return {
    project: input.project,
    event: await input.createEvent(input.project),
    createdProject: false,
    createdEvent: true,
  };
}
