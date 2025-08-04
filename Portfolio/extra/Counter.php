<?php
$counterFile = '.Counter';

// Check if the counter file exists
if (file_exists($counterFile)) {
    // Read the current count from the file
    $count = intval(file_get_contents($counterFile));

    // Increment the count
    $count++;

    // Write the updated count back to the file
    file_put_contents($counterFile, $count);

    // Display the updated count (output to be fetched by JavaScript)
    echo $count;
} else {
    echo "Counter file not found.";
}
?>