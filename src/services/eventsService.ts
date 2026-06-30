import type { ExternalEventRecord } from "../types.js";

export class EventsService {
  async listUpcomingUfcEvents(): Promise<ExternalEventRecord[]> {
    return [
      {
        id: "sample-ufc-card",
        title: "Sample UFC Event",
        startsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        venue: "TBD Arena",
        city: "Las Vegas",
        country: "USA",
      },
    ];
  }
}
