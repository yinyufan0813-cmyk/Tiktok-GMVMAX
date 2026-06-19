#!/usr/bin/env python3
import csv
import os
import sys
import tkinter as tk
from collections import OrderedDict
from datetime import datetime


ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.realpath(__file__)), ".."))
DATA_DIR = os.path.abspath(os.environ.get("GMVMAX_DATA_DIR") or os.environ.get("GMVMAX_OUTPUT_DIR") or os.path.join(ROOT, "logs"))
DATA_FILE = os.path.join(DATA_DIR, "gmvmax-plan-records.csv")
REFRESH_MS = 30_000
WINDOW_W = 560
WINDOW_H = 560


class FloatWindow:
    def __init__(self, root):
        self.root = root
        self.drag_x = 0
        self.drag_y = 0

        root.title("GMV Max")
        root.geometry(f"{WINDOW_W}x{WINDOW_H}+40+90")
        root.minsize(500, 460)
        root.configure(bg="#0b1020")
        root.attributes("-topmost", True)
        root.lift()
        root.focus_force()

        self.canvas = tk.Canvas(root, bg="#0b1020", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<ButtonPress-1>", self.start_drag)
        self.canvas.bind("<B1-Motion>", self.drag)

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
            self.draw(rows)
        except Exception as exc:
            self.draw_error(str(exc))
        self.root.after(REFRESH_MS, self.refresh)

    def draw_shell(self):
        self.canvas.delete("all")
        width = max(self.root.winfo_width(), WINDOW_W)
        height = max(self.root.winfo_height(), WINDOW_H)
        self.canvas.create_rectangle(0, 0, width, height, fill="#0b1020", outline="#334155", width=2)
        self.canvas.create_rectangle(0, 0, width, 58, fill="#111827", outline="")
        self.canvas.create_text(22, 30, text="LIVE GMV Max", fill="#f8fafc", font=("Helvetica", 18, "bold"), anchor="w")
        self.canvas.create_rectangle(width - 64, 16, width - 22, 42, fill="#1f2937", outline="#334155", width=1)
        self.canvas.create_text(width - 43, 29, text="x", fill="#e5e7eb", font=("Helvetica", 14, "bold"))
        self.canvas.tag_bind("close", "<Button-1>", lambda _event: self.root.destroy())
        close_id = self.canvas.create_rectangle(width - 64, 16, width - 22, 42, fill="", outline="", tags=("close",))
        self.canvas.tag_bind(close_id, "<Button-1>", lambda _event: self.root.destroy())
        return width, height

    def draw(self, rows):
        width, height = self.draw_shell()

        if not rows:
            self.canvas.create_text(
                24,
                92,
                text="Waiting for GMV Max data...",
                fill="#cbd5e1",
                font=("Helvetica", 15, "bold"),
                anchor="w",
            )
            self.canvas.create_text(24, 122, text=DATA_FILE, fill="#64748b", font=("Helvetica", 11), anchor="w")
            return

        timestamp = rows[0]["timestamp"]
        spend_total = sum_money(row["interval_spend_increase"] for row in rows)
        order_total = sum_money(row["interval_order_amount_increase"] for row in rows)

        self.canvas.create_text(width - 82, 30, text=format_time(timestamp), fill="#94a3b8", font=("Helvetica", 12), anchor="e")

        self.metric_box(18, 74, (width - 48) / 2, 82, "新增消耗", money(spend_total), "#fbbf24")
        self.metric_box(30 + (width - 48) / 2, 74, (width - 48) / 2, 82, "新增成交", money(order_total), "#38bdf8")

        y = 176
        card_h = 104
        for index, row in enumerate(rows, start=1):
            account = display_account(row, index)
            self.plan_card(18, y, width - 36, card_h, account, row)
            y += card_h + 12

        footer = f"每30秒刷新 | {os.path.relpath(DATA_FILE, ROOT)}"
        self.canvas.create_text(18, height - 18, text=footer, fill="#64748b", font=("Helvetica", 10), anchor="w")

    def draw_error(self, message):
        self.draw_shell()
        self.canvas.create_text(24, 90, text="悬浮窗读取数据失败", fill="#fca5a5", font=("Helvetica", 15, "bold"), anchor="w")
        self.canvas.create_text(24, 122, text=message, fill="#fecaca", font=("Helvetica", 12), anchor="nw", width=500)

    def metric_box(self, x, y, w, h, label, value, color):
        self.canvas.create_rectangle(x, y, x + w, y + h, fill="#172033", outline="#263244", width=1)
        self.canvas.create_text(x + 12, y + 23, text=label, fill="#94a3b8", font=("Helvetica", 11), anchor="w")
        self.canvas.create_text(x + 12, y + 55, text=value, fill=color, font=("Helvetica", 18, "bold"), anchor="w")

    def plan_card(self, x, y, w, h, account, row):
        self.canvas.create_rectangle(x, y, x + w, y + h, fill="#1f2937", outline="#334155", width=1)
        self.canvas.create_text(x + 12, y + 18, text=account, fill="#f8fafc", font=("Helvetica", 14, "bold"), anchor="w")
        self.small_metric(x + 12, y + 45, "新增消耗", row["interval_spend_increase"], "#fbbf24")
        self.small_metric(x + 145, y + 45, "新增成交", row["interval_order_amount_increase"], "#38bdf8")
        self.small_metric(x + 278, y + 45, "总消耗", row["total_spend"], "#e5e7eb")
        self.small_metric(x + 410, y + 45, "总成交", row["total_order_amount"], "#e5e7eb")

    def small_metric(self, x, y, label, value, color):
        self.canvas.create_text(x, y, text=label, fill="#94a3b8", font=("Helvetica", 10), anchor="w")
        self.canvas.create_text(x, y + 24, text=value or "0.00 MYR", fill=color, font=("Helvetica", 12, "bold"), anchor="w")


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
            key = row["account"] or row["campaign"] or f"row-{len(grouped) + 1}"
            grouped[key] = row
    return list(grouped.values())


def display_account(row, index):
    account = (row.get("account") or "").strip()
    if account:
        return account
    campaign = (row.get("campaign") or "").strip()
    if campaign and not campaign.startswith("live-plan"):
        return campaign
    return f"账号 {index}"


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
        return parsed.astimezone().strftime("%H:%M:%S")
    except ValueError:
        return value


def main():
    root = tk.Tk()
    FloatWindow(root)
    root.mainloop()


if __name__ == "__main__":
    sys.exit(main())
