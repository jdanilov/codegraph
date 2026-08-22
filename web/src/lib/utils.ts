import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui's class helper: conditional classes with Tailwind conflict merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 1234567 → "1,234,567" */
export function formatNumber(value: number): string {
  return value.toLocaleString();
}
