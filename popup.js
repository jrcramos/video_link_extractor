document.addEventListener('DOMContentLoaded', () => {
  const linksContainer = document.getElementById('links-container');
  const statusEl = document.getElementById('status');
  const clearButton = document.getElementById('clearButton');
  let currentTabId;

  // Function to render the list of links in the popup's UI
  function renderLinks(links) {
    // First, clear any previous content from the container
    linksContainer.innerHTML = '';

    // If the links array is empty or doesn't exist, show a helpful message
    if (!links || links.length === 0) {
      statusEl.textContent = 'No video or audio links found yet. Browse or reload the page.';
      return;
    }
    
    // Clear the status message if we have links to show
    statusEl.textContent = '';

    // Loop through each link and create the HTML elements for it
    links.forEach(link => {
      // Create the main container div for the list item
      const itemDiv = document.createElement('div');
      itemDiv.className = 'link-item';

      // Create the anchor (<a>) element for the link
      const linkElement = document.createElement('a');
      linkElement.href = link;
      linkElement.textContent = link; // The visible text is the link itself
      linkElement.target = '_blank';  // Ensure the link opens in a new tab

      // --- HOVER TOOLTIP IMPLEMENTATION ---
      // Set the 'title' attribute. The browser automatically uses this
      // to create a tooltip that shows the full text on hover.
      linkElement.title = link;
      // ------------------------------------
      
      itemDiv.appendChild(linkElement);

      // Create the "Copy" button
      const copyButton = document.createElement('button');
      copyButton.className = 'copy-btn';
      copyButton.textContent = 'Copy';

      // Add a click event listener to the copy button
      copyButton.addEventListener('click', () => {
        // Use the modern Clipboard API to write the link text
        navigator.clipboard.writeText(link).then(() => {
          // Provide visual feedback to the user
          copyButton.textContent = 'Copied!';
          // Revert the button text back to "Copy" after 1.5 seconds
          setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500);
        });
      });
      itemDiv.appendChild(copyButton);

      // Add the fully constructed item to the main container
      linksContainer.appendChild(itemDiv);
    });
  }

  // Function to request the list of links from the background script
  function requestLinks() {
      // Find the currently active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        // If no active tab is found, do nothing
        if (tabs.length === 0) return;
        
        currentTabId = tabs[0].id; // Store the tab ID for later use (like clearing)
        
        // Send a message to the service worker (background.js) to get the links
        chrome.runtime.sendMessage({ action: 'getLinks', tabId: currentTabId }, (response) => {
          if (chrome.runtime.lastError) {
              // Handle potential errors, e.g., if the extension context is invalidated
              console.error(chrome.runtime.lastError);
              statusEl.textContent = "Error loading links.";
          } else if (response && response.links) {
              // If successful, call renderLinks to display them
              renderLinks(response.links);
          }
        });
      });
  }

  // Add a click event listener for the "Clear" button
  clearButton.addEventListener('click', () => {
      if (currentTabId !== undefined) {
          // Send a message to the background script to clear the links for this tab
          chrome.runtime.sendMessage({ action: 'clearLinks', tabId: currentTabId }, (response) => {
              if (response && response.success) {
                  // If cleared successfully, re-render the UI with an empty list
                  renderLinks([]);
              }
          });
      }
  });

  // Initial call to get and display the links when the popup is first opened
  requestLinks();
});