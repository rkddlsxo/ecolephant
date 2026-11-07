import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Select } from './Select';

const options = [
  { value: 'a', label: '첫째' },
  { value: 'b', label: '둘째' },
  { value: 'c', label: '셋째' },
] as const;

afterEach(cleanup);

test('clicking an option selects it and closes the list', () => {
  const onChange = vi.fn();
  render(<Select label="항목" value="a" options={options} onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: '항목 첫째' });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: '둘째' }));
  expect(onChange).toHaveBeenCalledWith('b');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('keyboard opens, moves, selects and escapes', () => {
  const onChange = vi.fn();
  render(<Select label="항목" value="a" options={options} onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: '항목 첫째' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const list = screen.getByRole('listbox');
  fireEvent.keyDown(list, { key: 'End' });
  fireEvent.keyDown(list, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('c');

  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('disabled select does not open', () => {
  render(<Select label="항목" value="a" options={options} onChange={() => {}} disabled />);
  fireEvent.click(screen.getByRole('button', { name: '항목 첫째' }));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});
