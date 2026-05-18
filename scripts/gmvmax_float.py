#!/usr/bin/env python3
import csv
import os
import sys
import tkinter as tk
from collections import OrderedDict
from datetime import datetime


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_FILE = os.path.join(ROOT, "logs", "gmvmax-plan-records.csv")
REFRESH_MS = 30_000


class FloatWindow:
    def __init__(self, root):
        self.root = root
        self.drag_x = 0
        self.drag_y = 0

        root.title("GMV Max")
        root.configure(bg="#111827")
        root.attributes("-topmost", True)
        root.attributes("-alpha", 0.94)
        root.geometry("430x360+40+90")
        root.minsize(390, 300)

        self.header = tk.Frame(root, bg="#0f172a", height=44)
        self.header.pack(fill="x")
        self.header.bind("<ButtonPress-1>", self.start_drag)
        self.header.bind("<B1-Motion>", self.drag)

        self.title = tk.Label(
            self.header,
            text="LIVE GMV Max",
            bg="#0f172a",
            fg="#f8fafc",
            font=("Helvetica", 15, "bold"),
            padx=14,
        )
        self.title.pack(side="left", pady=10)
        self.title.bind("<ButtonPress-1>", self.start_drag)
        self.title.bind("<B1-Motion>", self.drag)

        self.status = tk.Label(
            self.header,
            text="loading",
            bg="#0f172a",
            fg="#94a3b8",
            font=("Helvetica", 11),
            padx=10,
        )
        self.status.pack(side="right", pady=10)

        self.close_button = tk.Button(
            self.header,
            text="x",
            command=root.destroy,
            bg="#1e293b",
            fg="#cbd5e1",
            activebackground="#334155",
            activeforeground="#ffffff",
            bd=0,
            width=3,
            font=("Helvetica", 12, "bold"),
        )
        self.close_button.pack(side="right", padx=(0, 8), pady=8)

        self.content = tk.Frame(root, bg="#111827")
        self.content.pack(fill="both", expand=True, padx=12, pady=10)

        self.footer = tk.Label(
            root,
            text="",
            bg="#111827",
            fg="#64748b",
            font=("Helvetica", 10),
            anchor="w",
            padx=12,
            pady=8,
        )
        self.footer.pack(fill="x")

        self.refresh()

    def start_drag(self, event):
        self.drag_x = event.x
        self.drag_y = event.y

    def drag(self, event):
        x = self.root.winfo_x() + event.x - self.drag_x
        y = self.root.winfo_y() + event.y - self.drag_y
        self.root.geometry(f"+{x}+{y}")

    def refresh(self):
        try:
            rows = latest_rows(DATA_FILE)
            self.render(rows)
        except Exception as exc:
            self.render_error(str(exc))
        self.root.after(REFRESH_MS, self.refresh)

    def render(self, rows):
        for child in self.content.winfo_children():
            child.destroy()

        if not rows:
            self.status.config(text="no data")
            self.footer.config(text=DATA_FILE)
            tk.Label(
                self.content,
                text="Waiting for GMV Max data...",
                bg="#111827",
                fg="#cbd5e1",
                font=("Helvetica", 13),
            ).pack(anchor="w", pady=18)
            return

        timestamp = rows[0]["timestamp"]
        self.status.config(text=format_time(timestamp))
        self.footer.config(text=f"Source: {os.path.relpath(DATA_FILE, ROOT)}")

        totals = {
            "interval_spend_increase": sum_money(row["interval_spend_increase"] for row in rows),
            "interval_order_amount_increase": sum_money(row["interval_order_amount_increase"] for row in rows),
        }

        summary = tk.Frame(self.content, bg="#172033")
        summary.pack(fill="x", pady=(0, 10))
        self.metric(summary, "新增消耗", money(totals["interval_spend_increase"]), 0, 0, "#fbbf24")
        self.metric(summary, "新增成交", money(totals["interval_order_amount_increase"]), 0, 1, "#38bdf8")

        for row in rows:
            self.plan_card(row)

    def render_error(self, message):
        for child in self.content.winfo_children():
            child.destroy()
        self.status.config(text="error")
        self.footer.config(text=DATA_FILE)
        tk.Label(
            self.content,
            text=message,
            bg="#111827",
            fg="#fca5a5",
            wraplength=380,
            justify="left",
            font=("Helvetica", 12),
        ).pack(anchor="w", pady=14)

    def plan_card(self, row):
        card = tk.Frame(self.content, bg="#1f2937", padx=10, pady=8)
        card.pack(fill="x", pady=5)

        account = tk.Label(
            card,
            text=row["account"] or "Unknown account",
            bg="#1f2937",
            fg="#f8fafc",
            font=("Helvetica", 13, "bold"),
            anchor="w",
        )
        account.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 6))

        self.metric(card, "新增消耗", row["interval_spend_increase"], 1, 0, "#fbbf24")
        self.metric(card, "新增成交", row["interval_order_amount_increase"], 1, 1, "#38bdf8")
        self.metric(card, "总消耗", row["total_spend"], 2, 0, "#cbd5e1")
        self.metric(card, "总成交", row["total_order_amount"], 2, 1, "#cbd5e1")

        card.grid_columnconfigure(0, weight=1)
        card.grid_columnconfigure(1, weight=1)

    def metric(self, parent, label, value, row, col, color):
        box = tk.Frame(parent, bg=parent["bg"])
        box.grid(row=row, column=col, sticky="ew", padx=4, pady=3)
        tk.Label(
            box,
            text=label,
            bg=parent["bg"],
            fg="#94a3b8",
            font=("Helvetica", 10),
            anchor="w",
        ).pack(anchor="w")
        tk.Label(
            box,
            text=value or "0.00 MYR",
            bg=parent["bg"],
            fg=color,
            font=("Helvetica", 13, "bold"),
            anchor="w",
        ).pack(anchor="w")


def latest_rows(path):
    if not os.path.exists(path):
        return []

    with open(path, newline="", encoding="utf-8") as file:
        rows = list(csv.DictReader(file))

    if not rows:
        return []

    latest_timestamp = rows[-1]["timestamp"]
    grouped = OrderedDict()
    for row in rows:
        if row["timestamp"] == latest_timestamp:
            grouped[row["account"]] = row
    return list(grouped.values())


def parse_money(value):
    if not value:
        return 0.0
    cleaned = value.replace(",", "").replace("MYR", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def sum_money(values):
    return sum(parse_money(value) for value in values)


def money(value):
    return f"{value:,.2f} MYR"


def format_time(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        local = parsed.astimezone()
        return local.strftime("%H:%M:%S")
    except ValueError:
        return value


def main():
    root = tk.Tk()
    FloatWindow(root)
    root.mainloop()


if __name__ == "__main__":
    sys.exit(main())
