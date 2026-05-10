export type QueuePressureClass = "normal" | "watch" | "defer" | "block" | "needs_bk";
export type QueueAdmissionSubjectKind = "request" | "recovery_request" | "routine_trigger" | "action";
export type QueueAdmissionDecision = "accept" | "defer" | "block" | "ask_bk";

export interface QueueAdmissionRecord {
  schemaVersion: 1;
  decidedAt: string;
  subjectKind: QueueAdmissionSubjectKind;
  decision: QueueAdmissionDecision;
  pressureClass: QueuePressureClass;
  reason: string;
}
