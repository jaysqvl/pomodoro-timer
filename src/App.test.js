import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import PlayButton from './PlayButton';
import PauseButton from './PauseButton';
import SettingsButton from './SettingsButton';

test('renders the existing progress display and three timer controls', () => {
  render(<App />);
  expect(screen.getByText('60%')).toBeInTheDocument();
  expect(screen.getByText('settings')).toBeInTheDocument();
  expect(screen.getAllByRole('button')).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
});

test.each([
  ['play', PlayButton],
  ['pause', PauseButton],
  ['settings', SettingsButton],
])('%s control forwards button props and click handlers', (name, Component) => {
  const onClick = jest.fn();
  const { rerender } = render(<Component aria-label={name} onClick={onClick} />);
  const button = screen.getByRole('button', { name });
  expect(button.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24');
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
  rerender(<Component aria-label={name} disabled onClick={onClick} />);
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
});
