import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const TestComponent = () => {
  return <div>Hello Vitest</div>;
};

describe('Example Test', () => {
  it('should render correctly', () => {
    render(<TestComponent />);
    expect(screen.getByText('Hello Vitest')).toBeInTheDocument();
  });

  it('should pass basic assertion', () => {
    expect(1 + 1).toBe(2);
  });
});
