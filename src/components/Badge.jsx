import React from "react";

export default function Badge({ status }) {
  const good = [
    "Ready",
    "Running",
    "Active",
    "Succeeded",
    "Normal",
    "Available",
    "Bound",
    "Established",
  ].includes(status);
  const bad =
    /error|fail|crash|backoff|notready|unavailable|warning|evicted|lost|notestablished|nameconflict/i.test(
      status,
    );
  return (
    <span className={`badge ${good ? "good" : bad ? "bad" : "warn"}`}>
      <i />
      {status}
    </span>
  );
}
