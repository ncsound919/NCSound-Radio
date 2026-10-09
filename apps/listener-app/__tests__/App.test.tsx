/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders correctly', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<App />);
  });
  // Without an assertion this test passed even when the tree failed to render.
  expect(tree).not.toBeNull();
  expect(tree!.toJSON()).toBeTruthy();
});
