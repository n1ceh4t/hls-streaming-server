#!/usr/bin/env ts-node
/**
 * Script to manually delete the default channel
 */

import { Database } from '../src/infrastructure/database/Database';
import { ChannelRepository } from '../src/infrastructure/database/repositories/ChannelRepository';

async function deleteDefaultChannel() {
  try {
    // Initialize database
    Database.initialize();
    
    const channelRepository = new ChannelRepository();
    
    // Find all channels
    const allChannels = await channelRepository.findAll();
    
    console.log('Found channels:');
    allChannels.forEach(ch => {
      console.log(`  - ${ch.name} (${ch.slug}) [ID: ${ch.id}]`);
    });
    
    // Find default channel
    const defaultChannel = allChannels.find(
      ch => ch.name.toLowerCase().includes('default') || 
            ch.slug.toLowerCase().includes('default')
    );
    
    if (!defaultChannel) {
      console.log('\nNo default channel found. Available channels:');
      allChannels.forEach(ch => {
        console.log(`  ${ch.id} - ${ch.name} (${ch.slug})`);
      });
      console.log('\nPlease specify which channel to delete by ID or name.');
      process.exit(0);
    }
    
    console.log(`\nFound default channel: ${defaultChannel.name} (${defaultChannel.slug})`);
    console.log(`Deleting channel ID: ${defaultChannel.id}...`);
    
    // Delete the channel
    await channelRepository.delete(defaultChannel.id);
    
    console.log('✓ Default channel deleted successfully!');
    
    // Verify deletion
    const remainingChannels = await channelRepository.findAll();
    console.log(`\nRemaining channels: ${remainingChannels.length}`);
    remainingChannels.forEach(ch => {
      console.log(`  - ${ch.name} (${ch.slug})`);
    });
    
  } catch (error) {
    console.error('Error deleting default channel:', error);
    process.exit(1);
  } finally {
    await Database.close();
    process.exit(0);
  }
}

deleteDefaultChannel();

