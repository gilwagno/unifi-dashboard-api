import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('renders a div', () => {
    render(<div>ok</div>);
    expect(screen.getByText('ok')).toBeInTheDocument();
  });
});
