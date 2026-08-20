// F8: the notice pages render in place of an empty list when the runtime
// answers 501 — the visible half of the "no silent fakes" contract.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NotImplementedNotice } from "./NotImplementedNotice";

describe("NotImplementedNotice", () => {
  it("states the feature is not implemented, with the server detail", () => {
    render(<NotImplementedNotice detail="Not Implemented in this runtime" />);
    expect(
      screen.getByText(/not implemented on the current runtime/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Not Implemented in this runtime/),
    ).toBeInTheDocument();
  });

  it("renders without a detail line", () => {
    render(<NotImplementedNotice />);
    expect(
      screen.getByText(/not implemented on the current runtime/i),
    ).toBeInTheDocument();
  });
});
